import { test } from "node:test";
import { strict as assert } from "node:assert";
import { migrateHttpProviderImports } from "./http-provider-migration";
import { scanRuntimeDi } from "./static-di";
import * as ts from "@typescript/typescript6";
const migrate = (text: string) => migrateHttpProviderImports(text, "fixture.ts");
test("migrates only provider usage and preserves other imports", () => {
  const result = migrate(`import { provideHttpClient, withInterceptors, Module } from '@supacloud/app';\nprovideHttpClient(withInterceptors(auth));`);
  assert.equal(result.changed, true);
  assert.match(result.content, /withInterceptors \} from "@supacloud\/app\/http"/);
  assert.match(result.content, /provideHttpClient, Module/);
  assert.deepEqual(result.issues, []);
});
test("aliases remain bound to the same local name", () => {
  const result = migrate(`import { provideHttpClient as provide, withInterceptors as chain } from '@supacloud/app'; provide(chain(auth));`);
  assert.equal(result.changed, true);
  assert.match(result.content, /withInterceptors as chain/);
  assert.match(result.content, /provide\(chain\(auth\)\)/);
});
test("already migrated sources are idempotent", () => {
  const source = `import { provideHttpClient, withInterceptors } from '@supacloud/app'; provideHttpClient(withInterceptors(auth));`;
  const result = migrate(source);
  assert.equal(migrate(result.content).changed, false);
});
test("low-level array helpers are not silently changed", () => {
  const source = `import { withInterceptors, HttpClient } from '@supacloud/app'; new HttpClient({}, withInterceptors(auth));`;
  assert.equal(migrate(source).content, source);
});
test("mixed uses report a conflict and write no suggested edit", () => {
  const source = `import { provideHttpClient, withInterceptors } from '@supacloud/app'; provideHttpClient(withInterceptors(auth)); const list = withInterceptors(auth);`;
  const result = migrate(source);
  assert.equal(result.changed, false); assert.equal(result.content, source);
  assert.equal(result.issues[0]?.code, "http-provider-migration-ambiguous");
});
test("namespace use is explicit manual work", () => {
  const source = `import * as app from '@supacloud/app'; app.provideHttpClient(app.withInterceptors(auth));`;
  assert.equal(migrate(source).issues[0]?.code, "http-provider-migration-namespace");
});
test("shadowed helpers and unrelated packages are untouched", () => {
  const source = `import { provideHttpClient, withInterceptors } from '@supacloud/app'; function configure(provideHttpClient: Function) { provideHttpClient(withInterceptors(auth)); }`;
  assert.equal(migrate(source).changed, false);
  assert.equal(migrate(`import { provideHttpClient, withInterceptors } from 'another'; provideHttpClient(withInterceptors(auth));`).changed, false);
});
test("single-specifier imports can be moved without rewriting the statement", () => {
  const result = migrate(`// keep comment\nimport { withInterceptors as chain } from '@supacloud/app';\nimport { provideHttpClient } from '@supacloud/app';\nprovideHttpClient(chain(auth));`);
  assert.match(result.content, /^\/\/ keep comment/);
  assert.match(result.content, /import \{ withInterceptors as chain \} from "@supacloud\/app\/http"/);
});
test("mismatch reaches the existing compiler scan with the same remediation", () => {
  const source = `import { provideHttpClient, withInterceptors } from '@supacloud/app'; provideHttpClient(withInterceptors(auth));`;
  const diagnostics = scanRuntimeDi(ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true), "fixture.ts");
  assert.equal(diagnostics[0]?.code, "http-provider-import-mismatch");
  const fixed = migrate(source).content;
  assert.deepEqual(scanRuntimeDi(ts.createSourceFile("fixture.ts", fixed, ts.ScriptTarget.Latest, true), "fixture.ts"), []);
});
