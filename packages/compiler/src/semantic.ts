import { relative, resolve, sep } from "node:path";
import type {
  ApplicationGraph,
  CommandNode,
  ModuleNode,
  RouteNode,
} from "./types";
import { canonical, digest, sourceInventory } from "./delivery-files";
import { joinRoutePaths } from "./util";

/** The version of the semantic projection, independent from generated artifact versions. */
export const SEMANTIC_IDENTITY_VERSION = 1 as const;
export const SEMANTIC_POLICY_VERSION = "semantic-governance-v1" as const;
export const SEMANTIC_SCHEMA = "supacloud.semantic.v1" as const;

export type SemanticNodeKind =
  | "module" | "provider" | "route" | "command" | "job" | "query"
  | "permission" | "effect" | "contract" | "migration";

export interface SemanticNode {
  id: string;
  kind: SemanticNodeKind;
  module?: string;
  name: string;
  hash: string;
  /** The raw source digest for this node when a project inventory was supplied. */
  sourceHash?: string;
  dependencies: string[];
  /** Safe, source-location-free data used to explain a hash change. */
  value: unknown;
}

export interface SemanticSnapshot {
  version: typeof SEMANTIC_IDENTITY_VERSION;
  schema: typeof SEMANTIC_SCHEMA;
  compiler: "@supacloud/compiler";
  policyVersion: typeof SEMANTIC_POLICY_VERSION;
  /** Raw source hashes are retained separately from semantic hashes. */
  sourceHashes: Record<string, string>;
  sourceHash: string;
  semanticHash: string;
  nodes: SemanticNode[];
  /** Delivery/migration metadata is read-only input; it never becomes an executor. */
  migrations?: Array<{ id: string; hash: string; value: unknown }>;
}

export interface SemanticSnapshotOptions {
  sourceHashes?: Record<string, string>;
  delivery?: unknown;
}

export interface SemanticChange {
  type: "added" | "removed" | "changed";
  category: SemanticNodeKind | "generation";
  id: string;
  name: string;
  beforeHash?: string;
  afterHash?: string;
  risk: "breaking" | "behavioral" | "informational";
  reasons: string[];
}

export interface SemanticConflict {
  code:
    | "command-policy-conflict"
    | "route-contract-conflict"
    | "effect-policy-conflict"
    | "migration-fingerprint-conflict"
    | "generated-artifacts-stale";
  severity: "error" | "warn";
  category: "permission" | "route-contract" | "effect" | "migration" | "generation";
  message: string;
  nodes: string[];
  suggestion: string;
}

export interface SemanticDiff {
  version: typeof SEMANTIC_IDENTITY_VERSION;
  schema: "supacloud.semantic-diff.v1";
  baseHash: string;
  currentHash: string;
  changes: SemanticChange[];
  conflicts: SemanticConflict[];
  requiresRegeneration: boolean;
  summary: {
    added: number;
    removed: number;
    changed: number;
    breaking: number;
    conflicts: number;
  };
  ok: boolean;
}

export interface SemanticLens {
  schema: "supacloud.semantic-lens.v1";
  subject?: string;
  snapshot: SemanticSnapshot;
  nodes: SemanticNode[];
  conflicts: SemanticConflict[];
  readOnly: true;
}

/** Validate a persisted lens snapshot before an agent or CI compares it. */
export function parseSemanticSnapshot(input: unknown): SemanticSnapshot {
  if (!input || typeof input !== "object") throw new TypeError("Invalid semantic snapshot.");
  const value = input as Partial<SemanticSnapshot>;
  if (value.version !== SEMANTIC_IDENTITY_VERSION || value.schema !== SEMANTIC_SCHEMA
    || value.compiler !== "@supacloud/compiler" || value.policyVersion !== SEMANTIC_POLICY_VERSION
    || typeof value.semanticHash !== "string" || !Array.isArray(value.nodes)
    || typeof value.sourceHash !== "string" || !value.sourceHashes || typeof value.sourceHashes !== "object") {
    throw new TypeError("Invalid semantic snapshot schema.");
  }
  if (value.nodes.some(item => !item || typeof item !== "object" || typeof item.id !== "string"
    || typeof item.kind !== "string" || typeof item.hash !== "string" || !Array.isArray(item.dependencies))) {
    throw new TypeError("Invalid semantic snapshot nodes.");
  }
  return value as SemanticSnapshot;
}

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort(compare);

function sourceHashFor(file: string | undefined, sourceHashes: Record<string, string>): string | undefined {
  if (!file) return undefined;
  return sourceHashes[file] ?? sourceHashes[file.replaceAll(sep, "/")];
}

function safeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "file" && key !== "line" && key !== "expression")
      .map(([key, item]) => [key, safeValue(item)]));
  }
  return value;
}

function node(
  kind: SemanticNodeKind,
  id: string,
  name: string,
  value: unknown,
  dependencies: string[] = [],
  module?: string,
  file?: string,
  sourceHashes: Record<string, string> = {},
): SemanticNode {
  const normalized = safeValue(value);
  return {
    id, kind, name,
    ...(module === undefined ? {} : { module }),
    hash: digest(canonical({ kind, id, value: normalized, dependencies: sorted(dependencies) })),
    ...(sourceHashFor(file, sourceHashes) === undefined ? {} : { sourceHash: sourceHashFor(file, sourceHashes) }),
    dependencies: sorted(dependencies),
    value: normalized,
  };
}

function aspectNames(aspects: ModuleNode["aspects"]): string[] {
  return sorted((aspects ?? []).map(aspect => aspect.name));
}

function routeValue(module: ModuleNode, controller: ModuleNode["controllers"][number], route: RouteNode): unknown {
  return {
    module: module.name,
    controller: controller.className,
    method: route.method,
    path: joinRoutePaths(controller.path, route.path),
    handler: route.handler,
    command: route.command,
    permission: route.permission,
    idempotency: route.idempotency,
    tags: sorted(route.tags ?? []),
    body: route.body,
    params: route.params,
    query: route.query,
    headers: route.headers,
    cookie: route.cookie,
    response: route.response,
    responses: route.responses,
    contract: route.contract,
    schemaKinds: route.schemaKinds,
    nativeResponse: route.nativeResponse,
    effect: route.effect,
    effectMode: route.effectMode,
    guards: sorted(route.guards ?? []),
    canMatch: sorted(route.canMatch ?? []),
    canDeactivate: sorted(route.canDeactivate ?? []),
    resolvers: route.resolvers,
    aspects: aspectNames(route.aspects),
  };
}

function commandValue(command: CommandNode): unknown {
  return {
    name: command.name,
    className: command.className,
    rpc: command.rpc,
    permission: command.permission,
    transaction: command.transaction,
    audit: command.audit,
    idempotency: command.idempotency,
    tenantScope: command.tenantScope,
    branches: command.branches,
    branchesFallback: command.branchesFallback,
    uses: command.uses,
    aspects: aspectNames(command.aspects),
  };
}

function migrationEntries(delivery: unknown): Array<{ id: string; hash: string; value: unknown }> {
  if (!delivery || typeof delivery !== "object") return [];
  const candidate = delivery as { migrations?: unknown; bundle?: { migrations?: unknown } };
  const raw = Array.isArray(candidate.migrations) ? candidate.migrations
    : Array.isArray(candidate.bundle?.migrations) ? candidate.bundle.migrations : [];
  return raw.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const value = safeValue(item);
    const record = item as Record<string, unknown>;
    const id = [record.executor, record.version, record.name, record.path, index]
      .filter((part): part is string | number => typeof part === "string" || typeof part === "number")
      .join(":");
    return [{ id: `migration:${id}`, hash: digest(canonical(value)), value }];
  });
}

/** Build a deterministic, source-location-free semantic projection of the static graph. */
export function createSemanticSnapshot(graph: ApplicationGraph, options: SemanticSnapshotOptions = {}): SemanticSnapshot {
  const sourceHashes = Object.fromEntries(Object.entries(options.sourceHashes ?? {}).sort(([left], [right]) => compare(left, right)));
  const nodes: SemanticNode[] = [];
  const permissions = new Map<string, string[]>();
  const addPermission = (permission: string | undefined, owner: string): void => {
    if (!permission) return;
    const owners = permissions.get(permission) ?? [];
    owners.push(owner);
    permissions.set(permission, owners);
  };

  for (const module of [...graph.modules].sort((left, right) => compare(left.name, right.name))) {
    const moduleId = `module:${module.name}`;
    nodes.push(node("module", moduleId, module.name, {
      name: module.name,
      imports: sorted(module.imports),
      exports: sorted(module.exports),
      tags: sorted(module.tags ?? []),
      resources: sorted(module.resources ?? []),
      aspects: aspectNames(module.aspects),
      featureSpec: module.featureSpec,
    }, module.imports.map(imported => `module:${imported}`), module.name, module.file, sourceHashes));

    for (const provider of [...module.providers].sort((left, right) => compare(left.token, right.token))) {
      nodes.push(node("provider", `${moduleId}/provider:${provider.token}`, provider.token, {
        token: provider.token, tokenKind: provider.tokenKind, kind: provider.kind,
        useClass: provider.useClass, useValueExpr: provider.useValueExpr === undefined ? undefined : "[omitted]",
        useFactoryName: provider.useFactoryName, useExisting: provider.useExisting, scope: provider.scope,
        deps: provider.deps, dependencyOptions: provider.dependencyOptions, optionalDeps: provider.optionalDeps,
        selfDeps: provider.selfDeps, skipSelfDeps: provider.skipSelfDeps, hostDeps: provider.hostDeps,
        multi: provider.multi, providedIn: provider.providedIn, hasOnDestroy: provider.hasOnDestroy,
        hasOnInit: provider.hasOnInit, exported: provider.exported,
      }, provider.deps.map(dependency => `${moduleId}/provider:${dependency}`), module.name, provider.file, sourceHashes));
    }

    for (const controller of [...module.controllers].sort((left, right) => compare(left.className, right.className))) {
      for (const route of [...controller.routes].sort((left, right) => compare(
        `${left.method} ${left.path}`, `${right.method} ${right.path}`))) {
        const path = joinRoutePaths(controller.path, route.path);
        const routeId = `${moduleId}/route:${route.method} ${path}`;
        const value = routeValue(module, controller, route);
        const command = route.command ? module.commands.find(candidate => candidate.name === route.command || candidate.className === route.command) : undefined;
        nodes.push(node("route", routeId, `${route.method} ${path}`, value,
          [moduleId, ...(command ? [`${moduleId}/command:${command.name}`] : [])], module.name, controller.file, sourceHashes));
        addPermission(route.permission, routeId);
        if (route.effect || route.effectMode) {
          nodes.push(node("effect", `${routeId}/effect`, `${route.method} ${path}`, {
            effect: route.effect, effectMode: route.effectMode,
          }, [routeId], module.name, controller.file, sourceHashes));
        }
        if (route.contract || route.schemaKinds || route.body || route.params || route.query || route.response || route.responses) {
          nodes.push(node("contract", `${routeId}/contract`, `${route.method} ${path}`, {
            contract: route.contract, schemaKinds: route.schemaKinds, body: route.body,
            params: route.params, query: route.query, headers: route.headers, cookie: route.cookie,
            response: route.response, responses: route.responses,
          }, [routeId], module.name, controller.file, sourceHashes));
        }
      }
    }

    for (const command of [...module.commands].sort((left, right) => compare(left.name, right.name))) {
      const commandId = `${moduleId}/command:${command.name}`;
      nodes.push(node("command", commandId, command.name, commandValue(command),
        [moduleId, ...(command.uses ?? []).map(use => `resource:${use.resource}`)], module.name, module.file, sourceHashes));
      addPermission(command.permission, commandId);
    }
    for (const job of [...(module.jobs ?? [])].sort((left, right) => compare(left.name, right.name))) {
      nodes.push(node("job", `${moduleId}/job:${job.name}`, job.name, {
        name: job.name, className: job.className, serviceKey: job.serviceKey, scope: job.scope,
        input: job.input, output: job.output, schemaKinds: job.schemaKinds, mode: job.mode,
        timeoutSec: job.timeoutSec, maxAttempts: job.maxAttempts, idempotency: job.idempotency,
        tenantScope: job.tenantScope, uses: job.uses, aspects: aspectNames(job.aspects),
      }, [moduleId, ...(job.uses ?? []).map(use => `resource:${use.resource}`)], module.name, module.file, sourceHashes));
    }
    for (const query of [...module.queries].sort((left, right) => compare(left.name, right.name))) {
      const queryId = `${moduleId}/query:${query.name}`;
      nodes.push(node("query", queryId, query.name, query, [moduleId], module.name, module.file, sourceHashes));
      addPermission(query.permission, queryId);
    }
  }

  for (const [permission, owners] of [...permissions.entries()].sort(([left], [right]) => compare(left, right))) {
    nodes.push(node("permission", `permission:${permission}`, permission, { permission, owners: sorted(owners) }, owners));
  }
  if (graph.graphql) {
    nodes.push(node("contract", "contract:graphql", graph.graphql.schema, {
      schema: graph.graphql.schema,
      schemaHash: graph.graphql.schemaHash,
      schemaNormalizedHash: graph.graphql.schemaNormalizedHash,
      mode: graph.graphql.mode,
      documents: sorted(graph.graphql.documents),
      operations: graph.graphql.operations,
    }, graph.graphql.operations.map(operation => `contract:graphql:${operation.name}`)));
  }
  const migrations = migrationEntries(options.delivery);
  for (const migration of migrations) nodes.push(node("migration", migration.id, migration.id, migration.value));
  nodes.sort((left, right) => compare(left.id, right.id));
  const sourceHash = digest(canonical(sourceHashes));
  const semanticHash = digest(canonical({ version: SEMANTIC_IDENTITY_VERSION, policyVersion: SEMANTIC_POLICY_VERSION,
    nodes: nodes.map(({ id, kind, hash, dependencies }) => ({ id, kind, hash, dependencies })), migrations }));
  return {
    version: SEMANTIC_IDENTITY_VERSION,
    schema: SEMANTIC_SCHEMA,
    compiler: "@supacloud/compiler",
    policyVersion: SEMANTIC_POLICY_VERSION,
    sourceHashes,
    sourceHash,
    semanticHash,
    nodes,
    ...(migrations.length > 0 ? { migrations } : {}),
  };
}

/** Read the complete project inventory once, then preserve raw and semantic hashes separately. */
export async function createProjectSemanticSnapshot(
  graph: ApplicationGraph,
  rootDir: string,
  outDir?: string,
  delivery?: unknown,
): Promise<SemanticSnapshot> {
  const inventory = await sourceInventory(resolve(rootDir), resolve(rootDir, outDir ?? "generated"));
  const sourceHashes = Object.fromEntries([...inventory.entries()].map(([path, hash]) => [
    relative(resolve(rootDir), path).split(sep).join("/"), hash,
  ]));
  return createSemanticSnapshot(graph, { sourceHashes, delivery });
}

function changedKeys(before: unknown, after: unknown, prefix = ""): string[] {
  if (canonical(before) === canonical(after)) return [];
  if (!before || !after || typeof before !== "object" || typeof after !== "object" || Array.isArray(before) || Array.isArray(after)) {
    return [prefix || "value"];
  }
  const keys = sorted([...Object.keys(before as Record<string, unknown>), ...Object.keys(after as Record<string, unknown>)]);
  return keys.flatMap(key => changedKeys((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key));
}

function categoryFor(node: SemanticNode): SemanticChange["category"] {
  return node.kind;
}

function riskFor(node: SemanticNode, reasons: string[], type: SemanticChange["type"]): SemanticChange["risk"] {
  if (type === "removed" || node.kind === "permission" || node.kind === "migration") return "breaking";
  if (node.kind === "route" || node.kind === "command" || node.kind === "contract" || node.kind === "effect") {
    if (reasons.some(reason => /permission|transaction|idempotency|response|body|params|query|effect|rpc|migration/i.test(reason))) return "breaking";
    return "behavioral";
  }
  return "informational";
}

function conflictForGraph(graph: ApplicationGraph): SemanticConflict[] {
  const conflicts: SemanticConflict[] = [];
  const routeOwners = new Map<string, string>();
  const commandOwners = new Map<string, CommandNode[]>();
  for (const module of graph.modules) {
    for (const command of module.commands) {
      const owners = commandOwners.get(command.name) ?? [];
      owners.push(command);
      commandOwners.set(command.name, owners);
    }
    for (const controller of module.controllers) {
      for (const route of controller.routes) {
        const path = joinRoutePaths(controller.path, route.path);
        const routeId = `${module.name}/route:${route.method} ${path}`;
        const key = `${route.method} ${path}`.replace(/:[^/]+/g, ":param");
        const existing = routeOwners.get(key);
        if (existing) conflicts.push({ code: "route-contract-conflict", severity: "error", category: "route-contract",
          message: `Public route ${key} is declared by both ${existing} and ${routeId}.`, nodes: [existing, routeId],
          suggestion: "Give the routes distinct method/path contracts before generating delivery artifacts." });
        else routeOwners.set(key, routeId);
        if (route.command) {
          const command = module.commands.find(candidate => candidate.name === route.command || candidate.className === route.command);
          if (command?.permission && route.permission && command.permission !== route.permission) {
            conflicts.push({ code: "command-policy-conflict", severity: "error", category: "permission",
              message: `Route ${routeId} requires ${route.permission}, but command ${command.name} requires ${command.permission}.`,
              nodes: [routeId, `${module.name}/command:${command.name}`], suggestion: "Declare one explicit permission at the governed command boundary." });
          }
        }
        if (route.effect?.retry === "explicit" && (!route.effect.maxAttempts || route.effect.maxAttempts < 2)) {
          conflicts.push({ code: "effect-policy-conflict", severity: "error", category: "effect",
            message: `Effect route ${routeId} requests explicit retry without maxAttempts >= 2.`, nodes: [`${routeId}/effect`],
            suggestion: "Set a bounded maxAttempts value or use retry: none." });
        }
        if (route.effect?.errors?.some(error => error.retryable && error.outcomeUnknown)) {
          conflicts.push({ code: "effect-policy-conflict", severity: "error", category: "effect",
            message: `Effect route ${routeId} marks an outcome-unknown failure as retryable.`, nodes: [`${routeId}/effect`],
            suggestion: "Outcome-unknown writes must be reconciled, never automatically retried." });
        }
      }
    }
  }
  for (const [name, owners] of commandOwners) {
    const signatures = new Set(owners.map(command => canonical(commandValue(command))));
    if (signatures.size > 1) conflicts.push({ code: "command-policy-conflict", severity: "error", category: "permission",
      message: `Command ${name} has multiple declarations with different governance policies.`, nodes: [...owners].map(command => `command:${command.name}`),
      suggestion: "Keep one command contract and route all transports through the same durable Command." });
  }
  return conflicts;
}

/** Diagnose conflicts in an in-memory graph or in a persisted semantic snapshot. */
export function diagnoseSemanticConflicts(input: ApplicationGraph | SemanticSnapshot): SemanticConflict[] {
  if ("modules" in input) return conflictForGraph(input);
  const migrations = input.migrations ?? input.nodes.filter(node => node.kind === "migration").map(node => ({ id: node.id, hash: node.hash, value: node.value }));
  const seen = new Map<string, string>();
  const conflicts: SemanticConflict[] = [];
  for (const migration of migrations) {
    const prior = seen.get(migration.id);
    if (prior !== undefined && prior !== migration.hash) conflicts.push({ code: "migration-fingerprint-conflict", severity: "error", category: "migration",
      message: `Migration ${migration.id} has incompatible fingerprints.`, nodes: [migration.id], suggestion: "Review the migration ledger and create a new version; never rewrite an applied migration." });
    seen.set(migration.id, migration.hash);
  }
  return conflicts;
}

/** Compare two semantic projections without comparing source locations or declaration ordering. */
export function diffSemanticSnapshots(base: SemanticSnapshot, current: SemanticSnapshot): SemanticDiff {
  if (base.schema !== SEMANTIC_SCHEMA || current.schema !== SEMANTIC_SCHEMA) throw new TypeError("Unsupported semantic snapshot schema.");
  const before = new Map(base.nodes.map(item => [item.id, item]));
  const after = new Map(current.nodes.map(item => [item.id, item]));
  const changes: SemanticChange[] = [];
  for (const id of sorted([...before.keys(), ...after.keys()])) {
    const left = before.get(id);
    const right = after.get(id);
    if (!left && right) changes.push({ type: "added", category: categoryFor(right), id, name: right.name, afterHash: right.hash,
      risk: riskFor(right, [], "added"), reasons: ["node-added"] });
    else if (left && !right) changes.push({ type: "removed", category: categoryFor(left), id, name: left.name, beforeHash: left.hash,
      risk: riskFor(left, [], "removed"), reasons: ["node-removed"] });
    else if (left && right && left.hash !== right.hash) {
      const reasons = changedKeys(left.value, right.value);
      changes.push({ type: "changed", category: categoryFor(right), id, name: right.name,
        beforeHash: left.hash, afterHash: right.hash, risk: riskFor(right, reasons, "changed"), reasons });
    }
  }
  const conflicts = [...diagnoseSemanticConflicts(base), ...diagnoseSemanticConflicts(current)];
  for (const change of changes) {
    if (change.category === "migration" && change.type === "changed") {
      conflicts.push({ code: "migration-fingerprint-conflict", severity: "error", category: "migration",
        message: `Migration ${change.id} changed fingerprint between snapshots.`, nodes: [change.id],
        suggestion: "Review the migration ledger and create a new version; never rewrite an applied migration." });
    }
  }
  const requiresRegeneration = changes.some(change => ["module", "provider", "route", "command", "job", "query", "contract", "effect", "permission", "migration"].includes(change.category));
  if (requiresRegeneration && !current.nodes.some(node => node.kind === "contract")) {
    conflicts.push({ code: "generated-artifacts-stale", severity: "warn", category: "generation",
      message: "Semantic contracts changed but the current snapshot contains no generated contract identity.", nodes: [],
      suggestion: "Regenerate application.ts, app.manifest.json and client contracts, then rerun app check." });
  }
  const summary = {
    added: changes.filter(change => change.type === "added").length,
    removed: changes.filter(change => change.type === "removed").length,
    changed: changes.filter(change => change.type === "changed").length,
    breaking: changes.filter(change => change.risk === "breaking").length,
    conflicts: conflicts.length,
  };
  return { version: SEMANTIC_IDENTITY_VERSION, schema: "supacloud.semantic-diff.v1", baseHash: base.semanticHash,
    currentHash: current.semanticHash, changes, conflicts, requiresRegeneration, summary, ok: conflicts.every(conflict => conflict.severity !== "error") };
}

export function createSemanticLens(
  graph: ApplicationGraph,
  subject?: string,
  options: SemanticSnapshotOptions = {},
): SemanticLens {
  const snapshot = createSemanticSnapshot(graph, options);
  const resolvedSubject = subject === undefined ? undefined : resolveSubjectModule(graph, subject).name;
  const modules = resolvedSubject ? graph.modules.filter(module => module.name === resolvedSubject) : graph.modules;
  const moduleNames = new Set(modules.map(module => module.name));
  const nodes = resolvedSubject
    ? snapshot.nodes.filter(item => item.module === resolvedSubject || (item.module === undefined && item.dependencies.some(dependency => moduleNames.has(dependency.replace(/^module:/, "")))))
    : snapshot.nodes;
  return { schema: "supacloud.semantic-lens.v1", ...(resolvedSubject === undefined ? {} : { subject: resolvedSubject }), snapshot, nodes,
    conflicts: diagnoseSemanticConflicts(graph), readOnly: true };
}

function resolveSubjectModule(graph: ApplicationGraph, subject: string): ModuleNode {
  const exact = graph.modules.find(module => module.name === subject);
  if (exact) return exact;
  const matches = graph.modules.filter(module =>
    module.className === subject
    || module.providers.some(provider => provider.token === subject || provider.useClass === subject)
    || module.controllers.some(controller => controller.className === subject)
    || module.commands.some(command => command.name === subject || command.className === subject)
    || (module.jobs ?? []).some(job => job.name === subject || job.className === subject || job.serviceKey === subject)
    || module.queries.some(query => query.name === subject || query.className === subject));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`Ambiguous semantic lens target "${subject}". Select a module name: ${matches.map(module => module.name).sort(compare).join(", ")}`);
  throw new Error(`No semantic lens target named "${subject}". Select a module name: ${graph.modules.map(module => module.name).sort(compare).join(", ") || "(none)"}`);
}
