import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateSourceBaseline } from './source-baseline.mjs';
const finding = { code: 'WS_PRIVATE_IMPORT', file: 'packages/client/src/index.ts', specifier: '@test/secret', fingerprint: 'a'.repeat(64), line: 1, column: 1 };
const budget = () => ({ schemaVersion: 1, entries: [{ ...finding, count: 1, reason: 'Existing bundled compatibility bridge; extract shared API before removal.' }] });
const report = (diagnostics = [], notes = []) => ({ schemaVersion: 1, filesScanned: 1, diagnostics, notes });

test('known debt is displayed and never presented as a clean audit', () => {
  const result = evaluateSourceBaseline(report([finding]), budget());
  assert.equal(result.passed, true); assert.equal(result.clean, false);
  assert.equal(result.existing.length, 1); assert.match(result.existing[0].reason, /compatibility/);
});
test('moving lines is harmless; adding a duplicate occurrence fails', () => {
  assert.equal(evaluateSourceBaseline(report([{ ...finding, line: 100 }]), budget()).passed, true);
  assert.equal(evaluateSourceBaseline(report([finding, { ...finding, line: 101 }]), budget()).introduced.length, 1);
});
test('changed symbols, targets, files, and rule codes cannot reuse an allowance', () => {
  for (const change of [{ fingerprint: 'b'.repeat(64) }, { specifier: '@test/other' }, { file: 'packages/client/src/new.ts' }, { code: 'WS_BOUNDARY_VIOLATION' }]) {
    assert.equal(evaluateSourceBaseline(report([{ ...finding, ...change }]), budget()).passed, false);
  }
});
test('new computed imports and unverified coverage findings also fail', () => {
  const note = { ...finding, code: 'WS_DYNAMIC_IMPORT', specifier: null };
  assert.equal(evaluateSourceBaseline(report([], [note]), budget()).passed, false);
});
test('fixed debt can disappear but is reported for explicit baseline cleanup', () => {
  const result = evaluateSourceBaseline(report(), budget());
  assert.equal(result.passed, true); assert.equal(result.clean, true); assert.equal(result.retired.length, 1);
});
test('missing inventories, invalid identities, duplicate or undocumented budgets fail closed', () => {
  for (const value of [null, { ...report(), filesScanned: 0 }, { ...report(), notes: undefined }, report([{ ...finding, fingerprint: undefined }])]) {
    assert.throws(() => evaluateSourceBaseline(value, budget()));
  }
  for (const baseline of [null, { entries: [] }, { ...budget(), entries: [...budget().entries, ...budget().entries] },
    { ...budget(), entries: [{ ...budget().entries[0], count: -1 }] }, { ...budget(), entries: [{ ...budget().entries[0], reason: '' }] }]) {
    assert.throws(() => evaluateSourceBaseline(report(), baseline));
  }
});
