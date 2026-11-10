import { test } from "node:test";
import { strict as assert } from "node:assert";
import { migrateHttpProviderImports } from "./http-provider-migration";
import { scanRuntimeDi } from "./static-di";
import * as ts from "./typescript";
const migrate = async (text: string) => (await migrateHttpProviderImports(text, "fixture.ts"));
test("migrates only provider usage and preserves other imports", async () => {
  const result = (await migrate(`import { provideHttpClient, withInterceptors, Module } from '@supacloud/app';\nprovideHttpClient(withInterceptors(auth));`));
  assert.equal(result.changed, true);
  assert.match(result.content, /withInterceptors \} from "@supacloud\/app\/http"/);
  assert.match(result.content, /provideHttpClient \} from "@supacloud\/app\/runtime"/);
  assert.match(result.content, /\{ Module \}/);
  assert.deepEqual(result.issues, []);
});
test("aliases remain bound to the same local name", async () => {
  const result = (await migrate(`import { provideHttpClient as provide, withInterceptors as chain } from '@supacloud/app'; provide(chain(auth));`));
  assert.equal(result.changed, true);
  assert.match(result.content, /withInterceptors as chain/);
  assert.match(result.content, /provide\(chain\(auth\)\)/);
});
test("already migrated sources are idempotent", async () => {
  const source = `import { provideHttpClient, withInterceptors } from '@supacloud/app'; provideHttpClient(withInterceptors(auth));`;
  const result = (await migrate(source));
  assert.equal((await migrate(result.content)).changed, false);
});
test("low-level array helpers are not silently changed", async () => {
  const source = `import { withInterceptors, HttpClient } from '@supacloud/app'; new HttpClient({}, withInterceptors(auth));`;
  const result = await migrate(source);
  assert.match(result.content, /withInterceptors \} from ['"]@supacloud\/app['"]/);
  assert.match(result.content, /HttpClient \} from "@supacloud\/app\/runtime"/);
  assert.match(result.content, /new HttpClient\(\{\}, withInterceptors\(auth\)\)/);
});
test("mixed uses report a conflict and write no suggested edit", async () => {
  const source = `import { provideHttpClient, withInterceptors } from '@supacloud/app'; provideHttpClient(withInterceptors(auth)); const list = withInterceptors(auth);`;
  const result = (await migrate(source));
  assert.equal(result.changed, false); assert.equal(result.content, source);
  assert.equal(result.issues[0]?.code, "http-provider-migration-ambiguous");
});
test("namespace use is explicit manual work", async () => {
  const source = `import * as app from '@supacloud/app'; app.provideHttpClient(app.withInterceptors(auth));`;
  assert.equal((await migrate(source)).issues[0]?.code, "http-provider-migration-namespace");
});
test("shadowed helpers stay in place and unrelated packages are untouched", async () => {
  const source = `import { provideHttpClient, withInterceptors } from '@supacloud/app'; function configure(provideHttpClient: Function) { provideHttpClient(withInterceptors(auth)); }`;
  const result = await migrate(source);
  assert.match(result.content, /provideHttpClient \} from "@supacloud\/app\/runtime"/);
  assert.match(result.content, /withInterceptors \} from ['"]@supacloud\/app['"]/);
  assert.match(result.content, /function configure\(provideHttpClient: Function\) \{ provideHttpClient\(withInterceptors\(auth\)\)/);
  assert.equal((await migrate(`import { provideHttpClient, withInterceptors } from 'another'; provideHttpClient(withInterceptors(auth));`)).changed, false);
});
test("single-specifier imports can be moved without rewriting the statement", async () => {
  const result = (await migrate(`// keep comment\nimport { withInterceptors as chain } from '@supacloud/app';\nimport { provideHttpClient } from '@supacloud/app';\nprovideHttpClient(chain(auth));`));
  assert.match(result.content, /^\/\/ keep comment/);
  assert.match(result.content, /import \{ withInterceptors as chain \} from "@supacloud\/app\/http"/);
});
test("mismatch reaches the existing compiler scan with the same remediation", async () => {
  const source = `import { provideHttpClient, withInterceptors } from '@supacloud/app'; provideHttpClient(withInterceptors(auth));`;
  const diagnostics = (await scanRuntimeDi((await ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true)), "fixture.ts"));
  assert.equal(diagnostics[0]?.code, "http-provider-import-mismatch");
  const fixed = (await migrate(source)).content;
  assert.deepEqual((await scanRuntimeDi((await ts.createSourceFile("fixture.ts", fixed, ts.ScriptTarget.Latest, true)), "fixture.ts")), []);
});
