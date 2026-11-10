import { describe, expect, test } from "bun:test";
import { createSemanticLens, createSemanticSnapshot, diagnoseSemanticConflicts, diffSemanticSnapshots, parseSemanticSnapshot } from "./semantic";
import type { ApplicationGraph } from "./types";

const graph = (overrides: Partial<ApplicationGraph> = {}): ApplicationGraph => ({
  externalTokens: [],
  modules: [{
    name: "orders", className: "OrdersModule", file: "orders.module.ts", line: 7,
    imports: [], providers: [], controllers: [{
      className: "OrdersController", path: "/orders", scope: "request", deps: [], file: "orders.controller.ts", importPath: "./orders.controller",
      routes: [{ method: "POST", path: "/:id/approve", handler: "approve", permission: "orders.approve", command: "Approve",
        contract: { body: "domain", response: "native-json" }, schemaKinds: { body: "declared", response: "declared" },
        effect: { required: true, retry: "none", errors: [{ tag: "denied", status: 403, code: "DENIED" }] } }],
    }],
    commands: [{ name: "orders.approve", className: "Approve", permission: "orders.approve", transaction: "required", idempotency: "required" }],
    jobs: [], queries: [], exports: [],
  }],
  ...overrides,
});

describe("semantic identity", () => {
  test("keeps source and semantic hashes separate and ignores source locations", () => {
    const first = createSemanticSnapshot(graph(), { sourceHashes: { "orders.module.ts": "a" } });
    const moved = createSemanticSnapshot({ ...graph(), modules: [{ ...graph().modules[0]!, line: 99 }] }, { sourceHashes: { "orders.module.ts": "a" } });
    expect(first.sourceHash).toBe(moved.sourceHash);
    expect(first.semanticHash).toBe(moved.semanticHash);
    expect(first.nodes.find(node => node.id === "module:orders")?.sourceHash).toBe("a");
  });

  test("classifies governance changes as semantic breaking changes", () => {
    const before = createSemanticSnapshot(graph());
    const after = createSemanticSnapshot({ ...graph(), modules: [{ ...graph().modules[0]!, commands: [{ ...graph().modules[0]!.commands[0]!, idempotency: "none" }] }] });
    const diff = diffSemanticSnapshots(before, after);
    expect(diff.changes.some(change => change.category === "command" && change.risk === "breaking" && change.reasons.includes("idempotency"))).toBe(true);
    expect(diff.requiresRegeneration).toBe(true);
  });

  test("detects permission and effect conflicts before generation", () => {
    const conflicted = graph({ modules: [{ ...graph().modules[0]!, controllers: [{ ...graph().modules[0]!.controllers[0]!, routes: [{
      ...graph().modules[0]!.controllers[0]!.routes[0]!, permission: "orders.read",
      effect: { required: true, retry: "explicit", maxAttempts: 1, errors: [{ tag: "unknown", status: 500, code: "UNKNOWN", retryable: true, outcomeUnknown: true }] },
    }] }] }] });
    const conflicts = diagnoseSemanticConflicts(conflicted);
    expect(conflicts.map(conflict => conflict.code)).toEqual(expect.arrayContaining(["command-policy-conflict", "effect-policy-conflict"]));
  });

  test("detects incompatible migration fingerprints", () => {
    const base = createSemanticSnapshot(graph(), { delivery: { migrations: [{ version: "1", name: "orders", executor: "project-migration", sha256: "a" }] } });
    const current = createSemanticSnapshot(graph(), { delivery: { migrations: [{ version: "1", name: "orders", executor: "project-migration", sha256: "b" }] } });
    const diff = diffSemanticSnapshots(base, current);
    expect(diff.changes.some(change => change.category === "migration")).toBe(true);
    expect(diff.conflicts.some(conflict => conflict.code === "migration-fingerprint-conflict")).toBe(true);
    expect(current.migrations?.[0]?.hash).not.toBe(base.migrations?.[0]?.hash);
  });

  test("lens scopes nodes without creating a second source of truth", () => {
    const lens = createSemanticLens(graph(), "orders");
    expect(lens.readOnly).toBe(true);
    expect(lens.nodes.every(node => node.module === "orders" || node.kind === "permission")).toBe(true);
    expect(lens.snapshot.schema).toBe("supacloud.semantic.v1");
  });

  test("ignores declaration order in unordered collections", () => {
    const base = graph();
    const module = base.modules[0]!;
    const route = module.controllers[0]!.routes[0]!;
    const errors = [
      { tag: "conflict", status: 409, code: "CONFLICT" },
      { tag: "unavailable", status: 503, code: "UNAVAILABLE" },
    ];
    const withErrors = (entries: typeof errors) => createSemanticSnapshot({ ...base, modules: [{ ...module,
      controllers: [{ ...module.controllers[0]!, routes: [{ ...route, effect: { required: true, retry: "none", errors: entries } }] }] }] });
    expect(withErrors(errors).semanticHash).toBe(withErrors([...errors].reverse()).semanticHash);

    const command = module.commands[0]!;
    const uses = [
      { resource: "db", operations: ["write" as const] },
      { resource: "queue", operations: ["publish" as const] },
    ];
    const withUses = (entries: typeof uses) => createSemanticSnapshot({ ...base, modules: [{ ...module,
      commands: [{ ...command, uses: entries }] }] });
    expect(withUses(uses).semanticHash).toBe(withUses([...uses].reverse()).semanticHash);
  });

  test("migration identity follows the ledger entry, not input position", () => {
    const base = graph();
    const first = { executor: "project-migration", version: "1", name: "orders", path: "migrations/1.sql", sha256: "a" };
    const second = { executor: "project-migration", version: "2", name: "refunds", path: "migrations/2.sql", sha256: "b" };
    const forward = createSemanticSnapshot(base, { delivery: { migrations: [first, second] } });
    const reversed = createSemanticSnapshot(base, { delivery: { migrations: [second, first] } });
    expect(forward.semanticHash).toBe(reversed.semanticHash);
    expect(forward.migrations?.map(item => item.id).sort()).toEqual(reversed.migrations?.map(item => item.id).sort());
  });

  test("routes Effect conflicts through the compiler validator", () => {
    const base = graph();
    const module = base.modules[0]!;
    const route = module.controllers[0]!.routes[0]!;
    const withEffect = (effect: NonNullable<typeof route.effect>) => diagnoseSemanticConflicts({ ...base, modules: [{ ...module,
      controllers: [{ ...module.controllers[0]!, routes: [{ ...route, effect }] }] }] });
    // The compiler accepts one bounded attempt; the lens must not invent a stricter rule.
    expect(withEffect({ required: true, retry: "explicit", maxAttempts: 1,
      errors: [{ tag: "unavailable", status: 503, code: "UNAVAILABLE", retryable: true }] })).toEqual([]);
    expect(withEffect({ required: true, retry: "explicit", maxAttempts: 2,
      errors: [{ tag: "unknown", status: 503, code: "UNKNOWN", retryable: true, outcomeUnknown: true }] })
      .map(conflict => conflict.code)).toContain("effect-policy-conflict");
  });

  test("diagnoses command and route conflicts from a persisted snapshot", () => {
    const base = graph();
    const module = base.modules[0]!;
    const controller = module.controllers[0]!;
    const route = controller.routes[0]!;
    const snapshot = createSemanticSnapshot({ ...base, modules: [
      { ...module, controllers: [{ ...controller, routes: [{ ...route, permission: "orders.read" }, { ...route, handler: "approveAgain" }] }] },
      { ...module, name: "refunds", className: "RefundsModule", file: "refunds.module.ts", commands: [],
        controllers: [{ ...controller, className: "RefundsController", routes: [{ ...route, permission: "orders.read" }] }] },
    ] });
    const codes = diagnoseSemanticConflicts(snapshot).map(conflict => conflict.code);
    expect(codes).toContain("route-contract-conflict");
    expect(codes).toContain("command-policy-conflict");
    expect(diffSemanticSnapshots(snapshot, snapshot).ok).toBe(false);
  });

  test("compact lens output omits graph values unless detail is requested", () => {
    const compact = createSemanticLens(graph(), "orders");
    expect(compact.nodes.every(node => node.value === undefined)).toBe(true);
    expect(compact.snapshot.nodes.every(node => node.value === undefined)).toBe(true);
    const detailed = createSemanticLens(graph(), "orders", { detail: true });
    expect(detailed.nodes.some(node => node.value !== undefined)).toBe(true);
    expect(detailed.nodes.map(node => node.id)).toEqual(compact.nodes.map(node => node.id));
  });

  test("rejects snapshots from another policy or with invalid nodes", () => {
    const snapshot = createSemanticSnapshot(graph());
    const parsed = parseSemanticSnapshot(JSON.parse(JSON.stringify(snapshot)) as unknown);
    expect(parsed.semanticHash).toBe(snapshot.semanticHash);
    expect(parsed.nodes).toHaveLength(snapshot.nodes.length);
    expect(() => parseSemanticSnapshot({ ...snapshot, policyVersion: "semantic-governance-v0" })).toThrow(/Unsupported/);
    expect(() => parseSemanticSnapshot({ ...snapshot, nodes: [{ ...snapshot.nodes[0]!, kind: "unknown" }] })).toThrow(/nodes/);
    // A persisted `lens` document wraps the snapshot; the diff accepts both forms.
    expect(parseSemanticSnapshot({ schema: "supacloud.semantic-lens.v1", snapshot }).semanticHash).toBe(snapshot.semanticHash);
  });
});
