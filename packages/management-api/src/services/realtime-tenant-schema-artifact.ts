/**
 * The pinned upstream Realtime tenant schema, as an artifact this repository can
 * apply instead of inheriting it from the Elixir container.
 *
 * The SQL is not SupaCloud's: `realtime.list_changes`, `realtime.apply_rls`,
 * `realtime.subscription` and the rest belong to upstream Realtime 2.150.0, and
 * `tests/unit/supabase-schema.test.ts` keeps it that way — this repository never
 * hand-authors them. What it does own is delivering that exact artifact to a
 * tenant database, because the Rust gateway is now the default Realtime server
 * and the Elixir migrator that used to install these objects is not started.
 *
 * Integrity is enforced against the digests below, which are the same bytes the
 * reconciler registers (`realtime-tenant-schema-reconcile.service.ts`). A
 * tampered file, a missing file or a reordered `order.txt` refuses to load.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REALTIME_TENANT_SCHEMA_VERSION = "2.150.0";

/** sha256 over `path\0sql\0` for every file, in `order.txt` order. */
export const REALTIME_TENANT_SCHEMA_TREE_SHA256 =
  "d23fc35b20976fa852fa51bb1d68fd01930d8cd64f96f956cadaf40cf71c13c7";

/**
 * Per-file sha256 of the pinned runtime. `apply_rls.sql` and `list_changes.sql`
 * are the digests `realtime-tenant-schema-reconcile.service.ts` pins too, so the
 * two consumers of this artifact cannot drift apart silently.
 */
export const REALTIME_TENANT_SCHEMA_FILE_SHA256: ReadonlyMap<string, string> = new Map([
  ["realtime/functions/apply_rls.sql", "5c4c0651d8afa23b9ee7717e6b5255e122ff27674b525624faa97e6fbef0fb64"],
  ["realtime/functions/authorize.sql", "89b1dc92a26a58c323218775de80c9c9c434e9e7eac6117e1823d276e4b3a47e"],
  ["realtime/functions/broadcast_changes.sql", "1d7024a183124e28f3c4a109ad1d056014ec82bb4f80eaa72a326b7a2d1e682b"],
  ["realtime/functions/build_prepared_statement_sql.sql", "c743ecfcd3a6cc04f2fdfd857089a4510ecfea132bb3e76415de8a1aeb8fc360"],
  ["realtime/functions/cast.sql", "d87c6048f8e32b26829ad63a00e7a27a2d958899748c3d8b386b3e5597630ded"],
  ["realtime/functions/check_equality_op.sql", "25b9cfd2149b3bf642072da4977f4cc27dc9d7d3f0ade340a57b539fa853b2f5"],
  ["realtime/functions/filters_hash.sql", "de760385fa3bedcc57202ada4c03de10f47684cba37176b09910c099912917a5"],
  ["realtime/functions/is_visible_through_filters.sql", "618cf92ec9809baf48f2d15aa7890112bdb89272694c34b4c26b307aaf8e3538"],
  ["realtime/functions/list_changes.sql", "24bcf1dbb76f5fc40c2fcc4650b15b5d0b5528fb86fb651e1e6efb94cda31f92"],
  ["realtime/functions/list_changes_sync.sql", "a52ebab6347676039a18fca5c0daf95128224097bf01f93001d8d874ed7d39ee"],
  ["realtime/functions/quote_wal2json.sql", "54e306b44dd87db7e7281a76c812ef7e05473a184b4855255be0cd27872ac65f"],
  ["realtime/functions/send.sql", "7cec0dbb3170660a7c0dfc3c268049a36e81244b5dff5d541cb35dcfe2718baa"],
  ["realtime/functions/send_binary.sql", "ca4f39cf323dea8d1150faf04f93a8128b2df1835cf0a5b362aad0eeb027327f"],
  ["realtime/functions/settled_changes.sql", "44470d41d91d5251acad848f30018f1537025bfb8d38bab6c3a1a40a8d2be21d"],
  ["realtime/functions/subscription_check_filters.sql", "9a88127fa6d3d635370506aa1245143b0d60337b90406ca46c051e5b65c3f067"],
  ["realtime/functions/to_regrole.sql", "9b589d47514a52014387af807e2cfc78fad5ff56f4deb0065416d21c4be04014"],
  ["realtime/functions/topic.sql", "5c2676ebcf2fabbbb3f59ca391fff20dfab352d971be09d5c68fdae37ae4e740"],
  ["realtime/functions/wal2json_escape_identifier.sql", "fa5c2a4d6942cb3396661d7cb665a9f40cb5146c79902c85619b47c8cb45273d"],
  ["realtime/schema.sql", "5850e0bb39624715a7a8fd2e1aaef20ed62a5aad57643a3450e36bf19bc833ea"],
  ["realtime/tables/messages.sql", "8e89935349749d32074b387cf98ce8d263e528d9a6097a7d45ec01099b264dbb"],
  ["realtime/tables/subscription.sql", "2cb1c3deaed567c2ccef444826b9ba02e32df19e98dd180599995435d3037e19"],
  ["realtime/types/action.sql", "c9280cdf5cc18f596a519aaf9af4b1f113d1259784c24d16808a437412d961d7"],
  ["realtime/types/equality_op.sql", "5d9374fd875e88e37530fa60520adab9601b5a7c140d8b160a936c3b3a9cbfd7"],
  ["realtime/types/user_defined_filter.sql", "07d7d249e6286222ddcf9977e578d02d486f16e73794cc902ef9933f3bf8d316"],
  ["realtime/types/wal_column.sql", "3a0205ed600f2d511fb05730d2cd1493319c921e922b72c782b0c6e3293a4a9d"],
  ["realtime/types/wal_rls.sql", "a2a9680a9dc08a536730ff434dbad45e166fba03b48960b67c87f0b1d101c620"],
]);

export const REALTIME_TENANT_SCHEMA_OWNER = "supabase_realtime_admin";

export interface RealtimeTenantSchemaFile {
  path: string;
  sql: string;
  sha256: string;
}

export interface RealtimeTenantSchemaArtifact {
  version: string;
  directory: string;
  treeSha256: string;
  /** Files in the order they must be applied. */
  files: readonly RealtimeTenantSchemaFile[];
  /** Function name to the set of `md5(prosrc)` values this artifact defines. */
  functionBodies: ReadonlyMap<string, readonly string[]>;
}

export function defaultRealtimeTenantSchemaDirectory(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "db",
    "realtime-tenant-schema",
    REALTIME_TENANT_SCHEMA_VERSION,
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

/**
 * `prosrc` stores the function body exactly as submitted, delimiters excluded,
 * which is what lets the receipt compare the catalog against these bytes instead
 * of trusting a stored version number.
 */
const FUNCTION_BODY = /\$(\w*)\$([\s\S]*?)\$\1\$/g;
const FUNCTION_HEADER = /create\s+(?:or\s+replace\s+)?function\s+"?realtime"?\."?(\w+)"?/gi;

export function functionBodiesByMd5(sql: string): Map<string, string[]> {
  const bodies = [...sql.matchAll(FUNCTION_BODY)].map((match) => md5(match[2]!));
  const names = [...new Set([...sql.matchAll(FUNCTION_HEADER)].map((match) => match[1]!))];
  const result = new Map<string, string[]>();
  for (const name of names) {
    result.set(name, bodies.slice());
  }
  return result;
}

export async function loadRealtimeTenantSchemaArtifact(
  directory = defaultRealtimeTenantSchemaDirectory(),
): Promise<RealtimeTenantSchemaArtifact> {
  const order = (await readFile(join(directory, "order.txt"), "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (order.length === 0) {
    throw new Error("the Realtime tenant schema artifact has an empty order.txt");
  }

  const pinned = REALTIME_TENANT_SCHEMA_FILE_SHA256;
  const missing = [...pinned.keys()].filter((path) => !order.includes(path));
  if (missing.length > 0) {
    throw new Error(`the Realtime tenant schema order.txt is missing pinned files: ${missing.join(", ")}`);
  }
  const unexpected = order.filter((path) => !pinned.has(path));
  if (unexpected.length > 0) {
    throw new Error(`the Realtime tenant schema order.txt lists files that are not pinned: ${unexpected.join(", ")}`);
  }

  const tree = createHash("sha256");
  const files: RealtimeTenantSchemaFile[] = [];
  const functionBodies = new Map<string, string[]>();
  for (const path of order) {
    const sql = await readFile(join(directory, path), "utf8");
    const digest = sha256(sql);
    const expected = pinned.get(path)!;
    if (digest !== expected) {
      throw new Error(
        `the Realtime tenant schema artifact does not match the pinned ${REALTIME_TENANT_SCHEMA_VERSION} runtime: ${path}`,
      );
    }
    tree.update(path).update("\0").update(sql).update("\0");
    files.push({ path, sql, sha256: digest });
    for (const [name, bodies] of functionBodiesByMd5(sql)) {
      const known = functionBodies.get(name) ?? [];
      functionBodies.set(name, [...known, ...bodies].sort());
    }
  }
  const treeSha256 = tree.digest("hex");
  if (treeSha256 !== REALTIME_TENANT_SCHEMA_TREE_SHA256) {
    throw new Error(
      `the Realtime tenant schema artifact tree does not match the pinned ${REALTIME_TENANT_SCHEMA_VERSION} runtime`,
    );
  }

  return {
    version: REALTIME_TENANT_SCHEMA_VERSION,
    directory,
    treeSha256,
    files,
    functionBodies,
  };
}

export interface RealtimeTenantSchemaState {
  schemaExists: boolean;
  empty: boolean;
  subscriptionExists: boolean;
  subscriptionOwner: string | null;
  functions: { name: string; prosrcMd5: string; owner: string }[];
}

/**
 * One query: the catalog state the receipt decides on. Nothing here writes.
 *
 * `empty` is true only when the schema holds no relation, no type of its own and
 * no routine, which is exactly what the tenant bootstrap leaves behind.
 */
export function realtimeTenantSchemaInspectionSql(): string {
  return `SELECT json_build_object(
  'schemaExists', EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'realtime'),
  'empty', NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'realtime'
    UNION ALL
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'realtime' AND t.typtype IN ('c', 'e', 'd', 'r') AND t.typcategory <> 'A'
    UNION ALL
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'realtime'
  ),
  'subscriptionExists', to_regclass('realtime.subscription') IS NOT NULL,
  'subscriptionOwner', (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = to_regclass('realtime.subscription')),
  'functions', coalesce((
    SELECT json_agg(json_build_object('name', p.proname, 'prosrcMd5', md5(p.prosrc), 'owner', pg_get_userbyid(p.proowner)) ORDER BY p.proname)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'realtime'
  ), '[]'::json)
)`;
}

export function assertRealtimeTenantSchemaState(value: unknown): RealtimeTenantSchemaState {
  if (!value || typeof value !== "object") {
    throw new Error("the Realtime tenant schema inspection returned no state");
  }
  const state = value as Partial<RealtimeTenantSchemaState>;
  if (typeof state.schemaExists !== "boolean" || typeof state.empty !== "boolean"
    || typeof state.subscriptionExists !== "boolean" || !Array.isArray(state.functions)) {
    throw new Error("the Realtime tenant schema inspection returned an unexpected shape");
  }
  return {
    schemaExists: state.schemaExists,
    empty: state.empty,
    subscriptionExists: state.subscriptionExists,
    subscriptionOwner: state.subscriptionOwner ?? null,
    functions: state.functions.map((entry) => {
      if (!entry || typeof entry !== "object") {
        throw new Error("the Realtime tenant schema inspection returned an unexpected function entry");
      }
      const record = entry as Record<string, unknown>;
      if (typeof record["name"] !== "string" || typeof record["prosrcMd5"] !== "string" || typeof record["owner"] !== "string") {
        throw new Error("the Realtime tenant schema inspection returned an unexpected function entry");
      }
      return { name: record["name"], prosrcMd5: record["prosrcMd5"], owner: record["owner"] };
    }),
  };
}

export type RealtimeTenantSchemaDecision =
  | { mode: "install"; reason: string }
  | { mode: "pinned"; reason: string };

/**
 * Decide whether this database still needs the artifact, already has exactly it,
 * or holds a shape this repository will not overwrite.
 */
export function decideRealtimeTenantSchema(
  artifact: RealtimeTenantSchemaArtifact,
  state: RealtimeTenantSchemaState,
): RealtimeTenantSchemaDecision {
  if (!state.schemaExists || state.empty) {
    return { mode: "install", reason: "the realtime schema is empty" };
  }
  if (!state.subscriptionExists) {
    throw new Error(
      `the realtime schema is not empty but has no realtime.subscription table; refusing to change it. `
      + `Run "bun run realtime:reconcile-schema" to plan a repair of a non-${artifact.version} Realtime schema.`,
    );
  }
  if (state.subscriptionOwner !== REALTIME_TENANT_SCHEMA_OWNER) {
    throw new Error(
      `realtime.subscription is owned by ${state.subscriptionOwner ?? "nobody"} instead of ${REALTIME_TENANT_SCHEMA_OWNER}; refusing to change the schema`,
    );
  }
  const catalog = new Map<string, string[]>();
  for (const entry of state.functions) {
    if (entry.owner !== REALTIME_TENANT_SCHEMA_OWNER) {
      throw new Error(
        `realtime.${entry.name} is owned by ${entry.owner} instead of ${REALTIME_TENANT_SCHEMA_OWNER}; refusing to change the schema`,
      );
    }
    catalog.set(entry.name, [...(catalog.get(entry.name) ?? []), entry.prosrcMd5].sort());
  }
  for (const [name, bodies] of artifact.functionBodies) {
    const installed = catalog.get(name);
    if (!installed) {
      throw new Error(
        `the realtime schema is missing realtime.${name}; run "bun run realtime:reconcile-schema" to plan a repair`,
      );
    }
    if (installed.length !== bodies.length || installed.some((value, index) => value !== bodies[index])) {
      throw new Error(
        `realtime.${name} is not the pinned ${artifact.version} definition; refusing to change the schema. `
        + `Run "bun run realtime:reconcile-schema" to plan a repair.`,
      );
    }
  }
  return { mode: "pinned", reason: `the realtime schema is the pinned ${artifact.version} artifact` };
}

/**
 * The statements to run once. The empty schema is replaced rather than filled in
 * place because the pinned SQL is not replay-safe: `schema.sql` is a bare
 * `create schema` and the types and tables are bare `create`.
 */
export function realtimeTenantSchemaBootstrapSql(artifact: RealtimeTenantSchemaArtifact): string {
  const body = artifact.files.map((file) => `-- ${file.path}\n${file.sql.trimEnd()}`).join("\n\n");
  return `-- SupaCloud applies the pinned upstream Realtime ${artifact.version} tenant schema.
-- The bytes are verified against REALTIME_TENANT_SCHEMA_FILE_SHA256 before this file is written.
BEGIN;
DROP SCHEMA IF EXISTS realtime CASCADE;
${body}
COMMIT;`;
}
