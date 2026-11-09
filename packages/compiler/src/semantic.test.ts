import { describe, expect, test } from "bun:test";
import { createSemanticLens, createSemanticSnapshot, diagnoseSemanticConflicts, diffSemanticSnapshots } from "./semantic";
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
});
