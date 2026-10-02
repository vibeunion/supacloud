import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as ts from "@typescript/typescript6";
import { scanRuntimeDi } from "./static-di";
import { createDiagnosticReport, toEditorDiagnostics } from "./diagnostics";

const scan = (code: string) => scanRuntimeDi(ts.createSourceFile("fixture.ts", code, ts.ScriptTarget.Latest, true), "fixture.ts");
const prefix = `import { computed, effect, untracked } from '@angular/core'; import { toSignal } from '@angular/core/rxjs-interop';`;
test("known aliased subscription creation fails in computed", () => {
  const diagnostics = scan(`import { computed as derive } from '@angular/core'; import { toScopedSignal as state } from '@supacloud/app/rxjs'; derive(() => state(stream, options));`);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.code, "reactive-subscription-in-computation");
});
test("namespace and local const aliases preserve API origin", () => {
  assert.equal(scan(`import * as ng from '@angular/core'; import * as rx from '@angular/core/rxjs-interop'; const bridge = rx.toSignal; ng.computed(() => bridge(stream));`).length, 1);
});
test("same-named local functions and shadowed imports are not rejected", () => {
  assert.deepEqual(scan(prefix + `function example(toSignal: Function) { return computed(() => toSignal(1)); }`), []);
  assert.deepEqual(scan(`function computed(x: Function) { return x(); } function toSignal(x: number) { return x; } computed(() => toSignal(1));`), []);
});
test("untracked callbacks and deferred closures are not treated as current computation", () => {
  assert.deepEqual(scan(prefix + `computed(() => untracked(() => toSignal(stream))); computed(() => () => toSignal(stream));`), []);
});
test("effect and immediate closures retain reactive context", () => {
  assert.equal(scan(prefix + `effect(() => { (() => toSignal(stream))(); });`).length, 1);
});
test("correctly created subscriptions can feed derived state", () => {
  assert.deepEqual(scan(prefix + `const state = toSignal(stream); const progress = computed(() => state()?.progress);`), []);
});
test("direct Angular runtime DI and reexported DI cannot escape SC2012", () => {
  assert.equal(scan(`import { inject as resolve } from '@angular/core';`).at(0)?.errorCode, "SC2012");
  assert.equal(scan(`export { inject as resolve } from '@angular/core';`).at(0)?.errorCode, "SC2012");
  assert.deepEqual(scan(`import type { Injector } from '@angular/core';`), []);
});
test("CLI/AI/editor adapters preserve guidance without inventing an automatic fix", () => {
  const diagnostics = scan(prefix + `computed(() => toSignal(stream));`);
  const report = createDiagnosticReport(diagnostics);
  const editor = toEditorDiagnostics(diagnostics);
  assert.deepEqual(editor[0]?.data.diagnostic, diagnostics[0]);
  assert.equal(editor[0]?.data.guidance, report.entries[0]?.guidance);
  assert.equal(report.entries[0]?.repair, undefined);
  assert.equal(editor[0]?.range.start.line, 0);
});

test("editor diagnostics preserve the compiler source span", () => {
  const diagnostics = scan(prefix + `computed(() => toSignal(stream));`);
  const diagnostic = diagnostics[0];
  assert.ok(diagnostic);
  assert.equal(typeof diagnostic.column, "number");
  assert.equal(diagnostic.endLine, diagnostic.line);
  assert.ok((diagnostic.endColumn ?? 0) > (diagnostic.column ?? 0));
  const editor = toEditorDiagnostics(diagnostics)[0];
  assert.deepEqual(editor?.range.start, { line: (diagnostic.line ?? 1) - 1, character: diagnostic.column });
  assert.deepEqual(editor?.range.end, { line: (diagnostic.endLine ?? 1) - 1, character: diagnostic.endColumn });
});
test("existing semantic fix payloads remain identical across consumers", () => {
  const diagnostics = [{ severity: "error" as const, code: "example", file: "a.ts", line: 3, message: "fix",
    fix: { type: "set_command_mode" as const, targetFile: "a.ts", command: "orders.save", property: "transaction" as const, expectedExpression: "false" },
  }];
  const report = createDiagnosticReport(diagnostics);
  assert.equal(report.entries[0]?.repair?.readiness, "input-required");
  assert.deepEqual(toEditorDiagnostics(diagnostics)[0]?.data.repair, report.entries[0]?.repair);
});

test("namespace DI checks respect shadowing and follow local const aliases", () => {
  assert.deepEqual(scan(`import * as core from '@angular/core'; function example(core: { inject(): void }) { core.inject(); }`), []);
  assert.equal(scan(`import * as core from '@angular/core'; const alias = core; alias.inject(Token);`).length, 1);
});
