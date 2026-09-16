import { createHash } from "node:crypto";
import { fingerprint, parse } from "libpg-query";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) { for (const item of value) walk(item, visit); }
  else if (record(value)) { visit(value); for (const item of Object.values(value)) walk(item, visit); }
}
function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => record(part) && record(part["String"]) && typeof part["String"]["sval"] === "string"
    ? [part["String"]["sval"]] : []);
}
const objectId = (kind: string, parts: readonly string[]) => `${kind}:${parts.map((part) => JSON.stringify(part)).join(".")}`;

export interface SqlAnalysis {
  fingerprint: string;
  defines: string[];
  touches: string[];
  references: string[];
  review: string[];
}

/** PostgreSQL 18 grammar, not regex-based SQL rewriting. Names group overloads conservatively. */
export async function analyzeSql(sql: string): Promise<SqlAnalysis> {
  const result: unknown = await parse(sql);
  const defines = new Set<string>(), touches = new Set<string>(), references = new Set<string>(), review = new Set<string>();
  const qualified = (kind: string, parts: string[]): string | undefined => {
    if (parts.length !== 2) { review.add(`Resolve unqualified or unsupported ${kind} name: ${parts.join(".")}`); return; }
    return objectId(kind, parts);
  };
  const relation = (value: unknown): string | undefined => {
    if (!record(value) || typeof value["relname"] !== "string") return;
    return qualified("relation", typeof value["schemaname"] === "string" ? [value["schemaname"], value["relname"]] : [value["relname"]]);
  };
  walk(result, (node) => {
    if (record(node["RangeVar"])) { const name = relation(node["RangeVar"]); if (name) references.add(name); }
    if (record(node["FuncCall"])) { const name = qualified("function", names(node["FuncCall"]["funcname"])); if (name) references.add(name); }
    if (record(node["Constraint"])) { const name = relation(node["Constraint"]["pktable"]); if (name) references.add(name); }
  });
  const statements: unknown[] = record(result) && Array.isArray(result["stmts"]) ? result["stmts"] : [];
  for (const raw of statements) {
    if (!record(raw) || !record(raw["stmt"])) throw new Error("Invalid PostgreSQL parse tree");
    const [kind, node] = Object.entries(raw["stmt"])[0] ?? [];
    if (!kind || !record(node)) throw new Error("Invalid SQL statement");
    const target = relation(node["relation"] ?? node["view"] ?? node["table"]);
    if (target) {
      touches.add(target);
      if (kind === "CreateStmt" || kind === "ViewStmt") defines.add(target);
    }
    if (kind === "DropStmt") {
      for (const item of Array.isArray(node["objects"]) ? node["objects"] : []) {
        const name = record(item) && record(item["List"])
          ? qualified(node["removeType"] === "OBJECT_TABLE" || node["removeType"] === "OBJECT_VIEW" ? "relation" : "object", names(item["List"]["items"]))
          : undefined;
        if (name) touches.add(name);
        else review.add("Review dropped object identity and dependencies");
      }
      review.add("Destructive DROP requires review");
    } else if (kind === "CreateFunctionStmt") {
      const name = qualified("function", names(node["funcname"]));
      if (name) { defines.add(name); touches.add(name); }
      let language: string | undefined, body: string | undefined;
      for (const item of Array.isArray(node["options"]) ? node["options"] : []) {
        if (!record(item) || !record(item["DefElem"])) continue;
        const option = item["DefElem"];
        if (option["defname"] === "language") language = names([option["arg"]])[0];
        if (option["defname"] === "as" && record(option["arg"]) && record(option["arg"]["List"])) body = names(option["arg"]["List"]["items"])[0];
      }
      if (language === "sql" && body !== undefined) {
        const nested = await analyzeSql(body);
        for (const name of [...nested.references, ...nested.touches]) references.add(name);
        for (const item of nested.review) review.add(item);
      } else {
        review.add("Function body dependencies require catalog verification or explicit reviewed dependencies");
      }
      review.add("Review function security, grants and overloads");
    } else if (!["SelectStmt", "CreateStmt", "ViewStmt", "AlterTableStmt", "IndexStmt",
      "InsertStmt", "UpdateStmt", "DeleteStmt", "CreatePolicyStmt", "AlterPolicyStmt", "CreateTrigStmt"].includes(kind)) {
      review.add(`Review unsupported dependency semantics: ${kind}`);
    }
    if (["AlterTableStmt", "CreatePolicyStmt", "AlterPolicyStmt", "CreateTrigStmt"].includes(kind)) {
      review.add(`Review schema/access impact: ${kind}`);
    }
  }
  return {
    fingerprint: await fingerprint(sql), defines: [...defines].sort(), touches: [...touches].sort(),
    references: [...references].sort(), review: [...review].sort(),
  };
}

/** Read-only admission check; PostgreSQL READ ONLY and least-privilege grants remain mandatory. */
export async function assertReadSql(sql: string): Promise<string> {
  const tree: unknown = await parse(sql);
  if (!record(tree) || !Array.isArray(tree["stmts"]) || tree["stmts"].length !== 1) throw new Error("Expected one read statement");
  const entry: unknown = tree["stmts"][0];
  if (!record(entry) || !record(entry["stmt"]) || !record(entry["stmt"]["SelectStmt"])) throw new Error("Expected SELECT");
  walk(tree, (node) => {
    if (["InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt", "IntoClause", "intoClause", "LockingClause"].some((name) => name in node)) {
      throw new Error("Mutating or locking SQL is not a read query");
    }
  });
  return fingerprint(sql);
}

export interface SqlMigrationSource {
  id: string;
  owner: string;
  sql: string;
  /** Object IDs from a reviewed catalog graph; never silently inferred for dynamic SQL. */
  dependencies?: readonly string[];
}
export interface SqlDependencyEdge { dependent: string; dependency: string }
export interface SqlCatalogDependencies { edges: SqlDependencyEdge[]; review: string[] }

/** Collapse columns/overloads to their owning object for conservative impact propagation. */
export async function readSqlDependencyGraph(
  executor: { query(sql: string, parameters: unknown[]): Promise<unknown> },
  schemas: readonly string[],
): Promise<SqlCatalogDependencies> {
  if (!schemas.length || schemas.some((schema) => !schema.trim())) throw new TypeError("Select explicit application schemas");
  // Scalar parameters avoid driver-specific array/JSON serialization.
  const schemaParameters = schemas.map((_, index) => `$${index + 1}::text`).join(", ");
  const rows = await executor.query(`
WITH objects AS (
  SELECT 'pg_class'::regclass::oid AS classid, c.oid AS objid, n.nspname,
    'relation:' || to_json(n.nspname)::text || '.' || to_json(c["relname"])::text AS identity
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  UNION ALL
  SELECT 'pg_proc'::regclass::oid, p.oid, n.nspname,
    'function:' || to_json(n.nspname)::text || '.' || to_json(p.proname)::text
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  UNION ALL
  SELECT 'pg_rewrite'::regclass::oid, r.oid, n.nspname,
    'relation:' || to_json(n.nspname)::text || '.' || to_json(c["relname"])::text
  FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace
  UNION ALL
  SELECT 'pg_policy'::regclass::oid, p.oid, n.nspname,
    'relation:' || to_json(n.nspname)::text || '.' || to_json(c["relname"])::text
  FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  UNION ALL
  SELECT 'pg_trigger'::regclass::oid, t.oid, n.nspname,
    'relation:' || to_json(n.nspname)::text || '.' || to_json(c["relname"])::text
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
)
SELECT DISTINCT a.identity AS dependent, b.identity AS dependency
FROM pg_depend d
JOIN objects a ON a.classid=d.classid AND a.objid=d.objid
JOIN objects b ON b.classid=d.refclassid AND b.objid=d.refobjid
WHERE a.nspname IN (${schemaParameters})
  AND b.nspname IN (${schemaParameters}) AND a.identity<>b.identity
ORDER BY dependent, dependency`, [...schemas]);
  if (!Array.isArray(rows)) throw new TypeError("Invalid PostgreSQL dependency rows");
  const edges = rows.map((row): SqlDependencyEdge => {
    if (!record(row) || typeof row["dependent"] !== "string" || typeof row["dependency"] !== "string") throw new TypeError("Invalid PostgreSQL dependency edge");
    return { dependent: row["dependent"], dependency: row["dependency"] };
  });
  const functions = await executor.query(`
SELECT DISTINCT n.nspname AS schema, p.proname AS name
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
JOIN pg_language l ON l.oid=p.prolang
WHERE n.nspname IN (${schemaParameters})
  AND (l.lanname='plpgsql' OR (l.lanname='sql' AND p.prosqlbody IS NULL))
ORDER BY schema, name`, [...schemas]);
  if (!Array.isArray(functions)) throw new TypeError("Invalid PostgreSQL function rows");
  return {
    edges,
    review: functions.map((row) => {
      if (!record(row) || typeof row["schema"] !== "string" || typeof row["name"] !== "string") throw new TypeError("Invalid function identity");
      return `Catalog cannot prove function-body dependencies: ${objectId("function", [row["schema"], row["name"]])}`;
    }),
  };
}
export interface SqlMigrationSnapshot {
  id: string; owner: string; sha256: string; analysis: SqlAnalysis;
}
export interface SqlImpactPlan {
  migrations: SqlMigrationSnapshot[];
  edges: SqlDependencyEdge[];
  changed: string[];
  affectedObjects: string[];
  affectedMigrations: string[];
  errors: string[];
  review: string[];
}

/** Offline, append-only migration review. Does not execute SQL or approve a deployment. */
export async function planSqlImpact(
  sources: readonly SqlMigrationSource[],
  baseline: readonly Pick<SqlMigrationSnapshot, "id" | "sha256">[] = [],
  catalogEdges: readonly SqlDependencyEdge[] = [],
): Promise<SqlImpactPlan> {
  const ids = new Set<string>();
  const migrations: SqlMigrationSnapshot[] = [];
  const edges = new Map<string, SqlDependencyEdge>();
  const addEdge = (dependent: string, dependency: string) => {
    if (dependent !== dependency) edges.set(JSON.stringify([dependent, dependency]), { dependent, dependency });
  };
  for (const edge of catalogEdges) addEdge(edge["dependent"], edge["dependency"]);
  for (const source of sources) {
    if (!source.id.trim() || !source.owner.trim() || ids.has(source.id)) throw new Error("Migration IDs must be unique and each migration must have an owner");
    ids.add(source.id);
    const analysis = await analyzeSql(source.sql);
    const references = [...new Set([...analysis.references, ...(source.dependencies ?? [])])].sort();
    for (const target of analysis.touches) for (const reference of references) addEdge(target, reference);
    migrations.push({ id: source.id, owner: source.owner,
      sha256: createHash("sha256").update(source.sql).digest("hex"), analysis: { ...analysis, references } });
  }
  const current = new Map(migrations.map((entry) => [entry.id, entry]));
  const previous = new Map(baseline.map((entry) => [entry.id, entry]));
  const errors: string[] = [];
  if (previous.size !== baseline.length) errors.push("Duplicate migration in baseline");
  for (const [index, old] of baseline.entries()) {
    if (current.get(old.id)?.sha256 !== old.sha256 || migrations[index]?.id !== old.id) {
      errors.push(`Applied migration removed, reordered or rewritten: ${old.id}`);
    }
  }
  const changed = migrations.filter((entry) => previous.get(entry.id)?.sha256 !== entry.sha256);
  const affected = new Set(changed.flatMap((entry) => entry.analysis.touches));
  const reverse = new Map<string, string[]>();
  for (const edge of edges.values()) {
    const values = reverse.get(edge["dependency"]) ?? [];
    values.push(edge["dependent"]); reverse.set(edge["dependency"], values);
  }
  for (const object of affected) for (const dependent of reverse.get(object) ?? []) affected.add(dependent);
  const definitions = new Map<string, number>();
  migrations.forEach((entry, index) => { for (const object of entry.analysis.defines) if (!definitions.has(object)) definitions.set(object, index); });
  migrations.forEach((entry, index) => {
    for (const reference of entry.analysis.references) {
      if ((definitions.get(reference) ?? -1) > index) errors.push(`${entry.id} references an object defined by a later migration: ${reference}`);
    }
  });
  return {
    migrations, edges: [...edges.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    changed: changed.map((entry) => entry.id), affectedObjects: [...affected].sort(),
    affectedMigrations: migrations.filter((entry) => [...entry.analysis.touches, ...entry.analysis.references].some((object) => affected.has(object))).map((entry) => entry.id),
    errors,
    review: changed.flatMap((entry) => entry.analysis.review.map((note) => `${entry.id}: ${note}`)),
  };
}
