import { relative, resolve, sep } from "node:path";
import type {
  ApplicationGraph,
  CommandNode,
  ControllerNode,
  EffectRouteNode,
  ModuleNode,
  RouteNode,
} from "./types";
import { canonical, digest, sourceInventory } from "./delivery-files";
import { validateEffectPolicies } from "./effect-governance";
import { joinRoutePaths, publicRouteKey } from "./util";

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
  /**
   * Safe, source-location-free data used to explain a hash change. Compact lens
   * output omits it; it is present on full snapshots and `--detail` output.
   */
  value?: unknown;
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
  delivery?: SemanticDeliveryInput;
}

/** Delivery/migration metadata is read-only input; the projection never executes it. */
export interface SemanticDeliveryInput {
  migrations?: readonly unknown[];
  bundle?: { migrations?: readonly unknown[] };
}

/** Lens options: a precomputed snapshot avoids a second projection, detail widens the payload. */
export interface SemanticLensOptions extends SemanticSnapshotOptions {
  snapshot?: SemanticSnapshot;
  detail?: boolean;
}

export interface SemanticChange {
  type: "added" | "removed" | "changed";
  category: SemanticNodeKind;
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
    | "migration-fingerprint-conflict";
  severity: "error";
  category: "permission" | "route-contract" | "effect" | "migration";
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

/** Accept a persisted lens output or a bare snapshot; both describe the same projection. */
export function parseSemanticSnapshot(input: unknown): SemanticSnapshot {
  if (!input || typeof input !== "object") throw new TypeError("Invalid semantic snapshot.");
  const unwrapped = (input as { snapshot?: unknown }).snapshot;
  const candidate = unwrapped !== null && typeof unwrapped === "object" ? unwrapped : input;
  const value = candidate as Partial<SemanticSnapshot>;
  if (value.version !== SEMANTIC_IDENTITY_VERSION || value.schema !== SEMANTIC_SCHEMA
    || value.compiler !== "@supacloud/compiler" || value.policyVersion !== SEMANTIC_POLICY_VERSION) {
    throw new TypeError(`Unsupported semantic snapshot identity; expected ${SEMANTIC_SCHEMA} with policy ${SEMANTIC_POLICY_VERSION}.`);
  }
  if (typeof value.semanticHash !== "string" || !Array.isArray(value.nodes)
    || typeof value.sourceHash !== "string" || !value.sourceHashes || typeof value.sourceHashes !== "object") {
    throw new TypeError("Invalid semantic snapshot schema.");
  }
  const kinds = new Set<SemanticNodeKind>(["module", "provider", "route", "command", "job", "query", "permission", "effect", "contract", "migration"]);
  if (value.nodes.some(item => !item || typeof item !== "object" || typeof item.id !== "string"
    || !kinds.has(item.kind) || typeof item.hash !== "string" || !Array.isArray(item.dependencies))) {
    throw new TypeError("Invalid semantic snapshot nodes.");
  }
  if (value.migrations !== undefined && (!Array.isArray(value.migrations) || value.migrations.some(item =>
    !item || typeof item !== "object" || typeof item.id !== "string" || typeof item.hash !== "string"))) {
    throw new TypeError("Invalid semantic snapshot migrations.");
  }
  return value as SemanticSnapshot;
}

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort(compare);

/**
 * Normalize a collection the compiler treats as unordered. Declaration order of
 * dependencies, resource uses and error mappings is not semantic, so it must not
 * change the projected hash.
 */
function sortedValues<T>(values: readonly T[] | undefined): T[] | undefined {
  if (values === undefined) return undefined;
  return [...values].sort((left, right) => compare(canonical(left), canonical(right)));
}

function effectValue(effect: EffectRouteNode | undefined): unknown {
  if (effect === undefined) return undefined;
  return {
    ...effect,
    ...(effect.dependencies === undefined ? {} : { dependencies: sorted(effect.dependencies) }),
    ...(effect.errors === undefined ? {} : { errors: sortedValues(effect.errors) }),
  };
}

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
    effect: effectValue(route.effect),
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
    branches: sortedValues(command.branches),
    branchesFallback: command.branchesFallback,
    uses: sortedValues(command.uses),
    aspects: aspectNames(command.aspects),
  };
}

function migrationEntries(delivery: SemanticDeliveryInput | undefined): Array<{ id: string; hash: string; value: unknown }> {
  if (!delivery || typeof delivery !== "object") return [];
  const raw = Array.isArray(delivery.migrations) ? delivery.migrations
    : Array.isArray(delivery.bundle?.migrations) ? delivery.bundle.migrations : [];
  return raw.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const value = safeValue(item);
    const record = item as Record<string, unknown>;
    // The ledger identity is the migration's declared identity, not its position in the input.
    const identity = [record.executor, record.version, record.name, record.path]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(":");
    return [{ id: `migration:${identity || `entry-${index}`}`, hash: digest(canonical(value)), value }];
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
        deps: sorted(provider.deps), dependencyOptions: provider.dependencyOptions, optionalDeps: provider.optionalDeps,
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
            effect: effectValue(route.effect), effectMode: route.effectMode,
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
        tenantScope: job.tenantScope, uses: sortedValues(job.uses), aspects: aspectNames(job.aspects),
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
      operations: sortedValues(graph.graphql.operations),
    }, graph.graphql.operations.map(operation => `contract:graphql:${operation.name}`)));
  }
  const migrations = migrationEntries(options.delivery).sort((left, right) => compare(left.id, right.id));
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
  delivery?: SemanticDeliveryInput,
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

interface SemanticRouteFact {
  module: string;
  id: string;
  method: string;
  path: string;
  handler: string;
  command?: string;
  permission?: string;
  effect?: EffectRouteNode;
  effectMode?: "simple";
}

interface SemanticCommandFact {
  module: string;
  name: string;
  className: string;
  permission?: string;
  transaction: CommandNode["transaction"];
  idempotency: CommandNode["idempotency"];
  value: unknown;
}

interface SemanticFacts {
  routes: SemanticRouteFact[];
  commands: SemanticCommandFact[];
}

function commandFact(module: string, command: CommandNode): SemanticCommandFact {
  return {
    module,
    name: command.name,
    className: command.className,
    ...(command.permission === undefined ? {} : { permission: command.permission }),
    transaction: command.transaction,
    idempotency: command.idempotency,
    value: safeValue(commandValue(command)),
  };
}

function factsFromGraph(graph: ApplicationGraph): SemanticFacts {
  const routes: SemanticRouteFact[] = [];
  const commands: SemanticCommandFact[] = [];
  for (const module of graph.modules) {
    for (const command of module.commands) commands.push(commandFact(module.name, command));
    for (const controller of module.controllers) {
      for (const route of controller.routes) {
        const path = joinRoutePaths(controller.path, route.path);
        routes.push({
          module: module.name,
          id: `${module.name}/route:${route.method} ${path}`,
          method: route.method,
          path,
          handler: route.handler,
          ...(route.command === undefined ? {} : { command: route.command }),
          ...(route.permission === undefined ? {} : { permission: route.permission }),
          ...(route.effect === undefined ? {} : { effect: route.effect }),
          ...(route.effectMode === undefined ? {} : { effectMode: route.effectMode }),
        });
      }
    }
  }
  return { routes, commands };
}

/**
 * Rebuild governance facts from a persisted snapshot so CI and agents can
 * re-diagnose conflicts offline. Compact snapshots omit `value`, which degrades
 * this to migration-only diagnosis; `--detail` snapshots keep it.
 */
function factsFromSnapshot(snapshot: SemanticSnapshot): SemanticFacts {
  const routes: SemanticRouteFact[] = [];
  const commands: SemanticCommandFact[] = [];
  for (const node of snapshot.nodes) {
    const value = node.value;
    if (value === null || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const module = typeof record.module === "string" ? record.module : node.module ?? "";
    if (node.kind === "route") {
      routes.push({
        module,
        id: node.id,
        method: String(record.method ?? ""),
        path: String(record.path ?? ""),
        handler: String(record.handler ?? ""),
        ...(typeof record.command === "string" ? { command: record.command } : {}),
        ...(typeof record.permission === "string" ? { permission: record.permission } : {}),
        ...(record.effect === null || typeof record.effect !== "object" ? {} : { effect: record.effect as EffectRouteNode }),
        ...(record.effectMode === "simple" ? { effectMode: "simple" as const } : {}),
      });
    } else if (node.kind === "command") {
      commands.push({
        module,
        name: typeof record.name === "string" ? record.name : node.name,
        className: typeof record.className === "string" ? record.className : node.name,
        ...(typeof record.permission === "string" ? { permission: record.permission } : {}),
        transaction: record.transaction === "none" ? "none" : "required",
        idempotency: record.idempotency === "none" ? "none" : "required",
        value: record,
      });
    }
  }
  return { routes, commands };
}

/** A minimal graph so Effect governance is enforced by the compiler's own validator. */
function effectGraph(facts: SemanticFacts, route: SemanticRouteFact): ApplicationGraph {
  const controller = {
    className: `${route.module}SemanticController`,
    path: "",
    scope: "request",
    deps: [],
    file: "",
    routes: [{
      method: route.method,
      path: route.path,
      handler: route.handler,
      ...(route.command === undefined ? {} : { command: route.command }),
      ...(route.permission === undefined ? {} : { permission: route.permission }),
      ...(route.effect === undefined ? {} : { effect: route.effect }),
      ...(route.effectMode === undefined ? {} : { effectMode: route.effectMode }),
    }],
  } as unknown as ControllerNode;
  const commands = facts.commands
    .filter(command => command.module === route.module)
    .map(command => ({
      ...(command.permission === undefined ? {} : { permission: command.permission }),
      name: command.name,
      className: command.className,
      transaction: command.transaction,
      idempotency: command.idempotency,
    })) as unknown as CommandNode[];
  const module = {
    name: route.module,
    className: route.module,
    file: "",
    line: 1,
    imports: [],
    exports: [],
    providers: [],
    controllers: [controller],
    commands,
    jobs: [],
    queries: [],
    aspects: [],
  } as unknown as ModuleNode;
  return { externalTokens: [], modules: [module], diagnostics: [] } as unknown as ApplicationGraph;
}

/**
 * Reuse `validateEffectPolicies` so the lens can never disagree with `app check`.
 * Project-configured strictness (required mappings, dependencies, retry policy,
 * timeouts, tagged errors) stays with the compile options; the lens reports only
 * the policy rules every project must hold, which is a subset of compile output.
 */
function effectConflicts(facts: SemanticFacts): SemanticConflict[] {
  const conflicts: SemanticConflict[] = [];
  for (const route of facts.routes) {
    if (route.effect === undefined && route.effectMode === undefined) continue;
    const diagnostics = validateEffectPolicies(effectGraph(facts, route), {
      requireRouteEffects: false,
      requireErrorMappings: false,
      requireDependencies: false,
      requireRetryPolicy: false,
      requireTaggedErrorTypes: false,
      requireExactDependencyTypes: false,
      requireTimeoutForDependencies: false,
      forbidDirectRuntimeExecution: false,
      forbidDirectThrows: false,
    });
    for (const diagnostic of diagnostics) {
      conflicts.push({
        code: "effect-policy-conflict",
        severity: "error",
        category: "effect",
        message: diagnostic.message,
        nodes: [`${route.id}/effect`],
        suggestion: diagnostic.suggestion ?? "Align the route Effect contract with the compiler Effect policy.",
      });
    }
  }
  return conflicts;
}

function uniqueConflicts(conflicts: readonly SemanticConflict[]): SemanticConflict[] {
  const seen = new Set<string>();
  return conflicts.filter(conflict => {
    const key = `${conflict.code}|${conflict.nodes.join(",")}|${conflict.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function diagnoseFacts(facts: SemanticFacts): SemanticConflict[] {
  const conflicts: SemanticConflict[] = [];
  const routeOwners = new Map<string, string>();
  const commandOwners = new Map<string, SemanticCommandFact[]>();
  for (const command of facts.commands) {
    const owners = commandOwners.get(command.name) ?? [];
    owners.push(command);
    commandOwners.set(command.name, owners);
  }
  for (const route of [...facts.routes].sort((left, right) => compare(left.id, right.id))) {
    const key = publicRouteKey(route.method, route.path);
    const existing = routeOwners.get(key);
    if (existing === undefined) routeOwners.set(key, route.id);
    else conflicts.push({ code: "route-contract-conflict", severity: "error", category: "route-contract",
      message: `Public route ${key} is declared by both ${existing} and ${route.id}.`, nodes: [existing, route.id],
      suggestion: "Give the routes distinct method/path contracts before generating delivery artifacts." });
    if (route.command === undefined) continue;
    const command = facts.commands.find(candidate => candidate.module === route.module
      && (candidate.name === route.command || candidate.className === route.command));
    if (command?.permission !== undefined && route.permission !== undefined && command.permission !== route.permission) {
      conflicts.push({ code: "command-policy-conflict", severity: "error", category: "permission",
        message: `Route ${route.id} requires ${route.permission}, but command ${command.name} requires ${command.permission}.`,
        nodes: [route.id, `${route.module}/command:${command.name}`],
        suggestion: "Declare one explicit permission at the governed command boundary." });
    }
  }
  for (const [name, owners] of commandOwners) {
    const signatures = new Set(owners.map(command => canonical(command.value)));
    if (signatures.size > 1) conflicts.push({ code: "command-policy-conflict", severity: "error", category: "permission",
      message: `Command ${name} has multiple declarations with different governance policies.`,
      nodes: owners.map(command => `${command.module}/command:${command.name}`).sort(compare),
      suggestion: "Keep one command contract and route all transports through the same durable Command." });
  }
  conflicts.push(...effectConflicts(facts));
  return uniqueConflicts(conflicts);
}

function migrationConflicts(snapshot: SemanticSnapshot): SemanticConflict[] {
  const migrations = snapshot.migrations
    ?? snapshot.nodes.filter(node => node.kind === "migration").map(node => ({ id: node.id, hash: node.hash }));
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

/** Diagnose conflicts in an in-memory graph or in a persisted semantic snapshot. */
export function diagnoseSemanticConflicts(input: ApplicationGraph | SemanticSnapshot): SemanticConflict[] {
  if ("modules" in input) return diagnoseFacts(factsFromGraph(input));
  return uniqueConflicts([...diagnoseFacts(factsFromSnapshot(input)), ...migrationConflicts(input)]);
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
      // Compact snapshots omit values; the hash still carries the change.
      if (reasons.length === 0) reasons.push("hash");
      changes.push({ type: "changed", category: categoryFor(right), id, name: right.name,
        beforeHash: left.hash, afterHash: right.hash, risk: riskFor(right, reasons, "changed"), reasons });
    }
  }
  const conflicts = uniqueConflicts([...diagnoseSemanticConflicts(base), ...diagnoseSemanticConflicts(current)]);
  for (const change of changes) {
    if (change.category === "migration" && change.type === "changed") {
      conflicts.push({ code: "migration-fingerprint-conflict", severity: "error", category: "migration",
        message: `Migration ${change.id} changed fingerprint between snapshots.`, nodes: [change.id],
        suggestion: "Review the migration ledger and create a new version; never rewrite an applied migration." });
    }
  }
  const requiresRegeneration = changes.some(change => ["module", "provider", "route", "command", "job", "query", "contract", "effect", "permission", "migration"].includes(change.category));
  const unique = uniqueConflicts(conflicts);
  const summary = {
    added: changes.filter(change => change.type === "added").length,
    removed: changes.filter(change => change.type === "removed").length,
    changed: changes.filter(change => change.type === "changed").length,
    breaking: changes.filter(change => change.risk === "breaking").length,
    conflicts: unique.length,
  };
  return { version: SEMANTIC_IDENTITY_VERSION, schema: "supacloud.semantic-diff.v1", baseHash: base.semanticHash,
    currentHash: current.semanticHash, changes, conflicts: unique, requiresRegeneration, summary, ok: unique.every(conflict => conflict.severity !== "error") };
}

/** Compact nodes keep identity without the graph payload; `detail` restores it. */
function compactNode(node: SemanticNode): SemanticNode {
  const { value: _value, ...rest } = node;
  return rest;
}

export function createSemanticLens(
  graph: ApplicationGraph,
  subject?: string,
  options: SemanticLensOptions = {},
): SemanticLens {
  const snapshot = options.snapshot ?? createSemanticSnapshot(graph, options);
  const resolvedSubject = subject === undefined ? undefined : resolveSubjectModule(graph, subject).name;
  const modules = resolvedSubject ? graph.modules.filter(module => module.name === resolvedSubject) : graph.modules;
  const moduleNames = new Set(modules.map(module => module.name));
  const nodes = resolvedSubject
    ? snapshot.nodes.filter(item => item.module === resolvedSubject || (item.module === undefined && item.dependencies.some(dependency => moduleNames.has(dependency.replace(/^module:/, "")))))
    : snapshot.nodes;
  const detail = options.detail === true;
  return {
    schema: "supacloud.semantic-lens.v1",
    ...(resolvedSubject === undefined ? {} : { subject: resolvedSubject }),
    // Default output is safe to hand to an agent or persist in CI: identities only.
    snapshot: detail ? snapshot : { ...snapshot, nodes: snapshot.nodes.map(compactNode) },
    nodes: detail ? nodes : nodes.map(compactNode),
    conflicts: diagnoseSemanticConflicts(graph),
    readOnly: true,
  };
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
