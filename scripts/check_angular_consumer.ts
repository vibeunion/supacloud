/** Exercise candidate package entrypoints with a real Angular host outside the workspace. */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installStarterConsumer, runStarterCommand } from "./check_app_starter";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "supacloud-angular-consumer-"));
const project = join(temporary, "consumer");
const interruption = new AbortController();
const interrupt = () => interruption.abort(new Error("Angular consumer verification interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const env: Record<string, string> = {};
// Do not pass application credentials, NODE_PATH, registry tokens or user config
// into the synthetic consumer. Packages are public; the installer owns the lock.
for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT", "TMP", "TEMP", "TMPDIR"]) {
  const value = process.env[key];
  if (value !== undefined) env[key] = value;
}
env.HOME = join(temporary, "home");
env.USERPROFILE = env.HOME;
env.XDG_CONFIG_HOME = join(env.HOME, ".config");
env.BUN_TMPDIR = join(temporary, "bun-tmp");
const run = (args: string[], cwd = project): Promise<string> => runStarterCommand(args, {
  cwd, env, signal: interruption.signal, timeoutMs: 180_000,
});

try {
  for (const directory of [project, env.HOME, env.BUN_TMPDIR]) await mkdir(directory, { recursive: true });
  const overrides: Record<string, string> = {};
  for (const directory of ["contracts", "app", "testing", "delivery", "compiler"]) {
    const root = join(repo, "packages", directory);
    const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    await readFile(join(root, "dist/index.js"));
    if (directory === "app") for (const entry of ["angular", "rxjs", "http", "runtime"]) {
      assert.equal(metadata.exports[`./${entry}`]?.import, `./dist/${entry}.js`);
      assert.equal(metadata.exports[`./${entry}`]?.types, `./dist/${entry}.d.ts`);
      await readFile(join(root, `dist/${entry}.js`));
      await readFile(join(root, `dist/${entry}.d.ts`));
    }
    await run(["pm", "pack", "--ignore-scripts", "--destination", temporary], root);
    const prefix = `${String(metadata.name).replace(/^@/, "").replaceAll("/", "-")}-`;
    const packed = (await readdir(temporary)).find(file => file.startsWith(prefix) && file.endsWith(".tgz"));
    assert.ok(packed, `Missing candidate ${metadata.name}`);
    overrides[metadata.name] = `file:${join(temporary, packed)}`;
  }
  const app = JSON.parse(await readFile(join(repo, "packages/app/package.json"), "utf8"));
  const angularVersion = app.peerDependencies?.["@angular/core"] ?? app.dependencies?.["@angular/core"];
  assert.equal(typeof angularVersion, "string", "A declared Angular compatibility range is required");
  await writeFile(join(project, "package.json"), JSON.stringify({
    name: "angular-consumer", private: true, type: "module",
    dependencies: { ...overrides, "@angular/core": angularVersion, rxjs: app.dependencies.rxjs },
    devDependencies: { typescript: app.devDependencies.typescript, "@types/node": app.devDependencies["@types/node"] },
    overrides,
  }, null, 2));
  await writeFile(join(project, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022", lib: ["ES2022", "DOM", "DOM.Iterable"],
      module: "NodeNext", moduleResolution: "NodeNext", types: ["node"],
      strict: true, skipLibCheck: false, noEmit: true,
    },
    include: ["consumer.ts"],
  }, null, 2));
  await writeFile(join(project, "consumer.ts"), consumerSource());
  await writeFile(join(project, "browser.ts"), `export { signal, computed, resource, assertNotInReactiveContext } from "@supacloud/app/angular";
export { toScopedSignal, takeUntilDestroyed } from "@supacloud/app/rxjs";
`);
  await writeFile(join(project, "bundle.mjs"), String.raw`import { strict as assert } from "node:assert";
const result = await Bun.build({ entrypoints: ["./browser.ts"], target: "browser", metafile: true });
assert.equal(result.success, true, String(result.logs));
assert.ok(result.metafile);
const inputs = Object.keys(result.metafile.inputs).map(path => path.replaceAll("\\", "/"));
const marker = "/node_modules/@angular/core/";
const angularRoots = new Set(inputs.filter(path => ("/" + path).includes(marker)).map(path => ("/" + path).split(marker)[0]));
assert.equal(angularRoots.size, 1, "Angular adapters must resolve one physical host runtime: " + JSON.stringify(inputs));
assert.ok(!inputs.some(path => /node:async_hooks|\/packages\/compiler\/|@supacloud\/app\/dist\/index\./.test(path)));
console.log("Packed Angular entrypoints use one host runtime and no server root");
`);
  await writeFile(join(project, "consumer-http.ts"), httpConsumerSource());
  await writeFile(join(project, "consumer-diagnostics.ts"), `import { strict as assert } from "node:assert";
import { createDiagnosticReport, toEditorDiagnostics } from "@supacloud/compiler/diagnostics";
const input = [{ severity: "error" as const, code: "http-provider-import-mismatch", message: "Invalid provider", file: "http.ts", line: 2, suggestion: "Preview migration" }];
const report = createDiagnosticReport(input);
assert.deepEqual(toEditorDiagnostics(input)[0]?.data.diagnostic, report.entries[0]?.diagnostic);
assert.equal(toEditorDiagnostics(input)[0]?.range.start.line, 1);
console.log("Packed diagnostic report and editor adapter share the compiler payload");
`);
  await writeFile(join(project, "tsconfig.http.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", lib: ["ES2022", "DOM", "DOM.Iterable"], module: "ESNext",
      moduleResolution: "Bundler", types: ["node"], strict: true, skipLibCheck: false, noEmit: true },
    include: ["consumer-http.ts", "consumer-diagnostics.ts"],
  }, null, 2));
  await installStarterConsumer(project, run);
  console.log(await run(["node_modules/typescript/bin/tsc", "--project", "tsconfig.json", "--pretty", "false"]));
  console.log(await run(["consumer.ts"]));
  // A separate process prevents production mode leaking into other tests.
  console.log(await run(["consumer.ts", "--production"]));
  console.log(await run(["bundle.mjs"]));
  console.log(await run(["node_modules/typescript/bin/tsc", "--project", "tsconfig.http.json", "--pretty", "false"]));
  console.log(await run(["consumer-http.ts"]));
  console.log(await run(["consumer-diagnostics.ts"]));
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await rm(temporary, { recursive: true, force: true });
}

function consumerSource(): string {
  return `import { strict as assert } from "node:assert";
import * as native from "@angular/core";
import * as official from "@supacloud/app/angular";
import { toScopedSignal, takeUntilDestroyed, type ReactiveScope } from "@supacloud/app/rxjs";
import { Observable, Subject } from "rxjs";

if (process.argv.includes("--production")) native.enableProdMode();
for (const name of ["signal", "computed", "effect", "resource", "Injector", "InjectionToken", "DestroyRef", "assertNotInReactiveContext", "assertInInjectionContext"] as const) {
  assert.equal(official[name], native[name], "Duplicate/wrapped Angular public API: " + name);
}
const controller = new AbortController();
const teardowns = new Set<() => void | Promise<void>>();
const owner: ReactiveScope = {
  get signal() { return controller.signal; },
  get destroyed() { return controller.signal.aborted; },
  onDestroy(callback) { teardowns.add(callback); return () => { teardowns.delete(callback); }; },
};
let subscriptions = 0, releases = 0;
const subject = new Subject<number>();
const source = new Observable<number>(subscriber => {
  subscriptions++;
  const inner = subject.subscribe(subscriber);
  return () => { releases++; inner.unsubscribe(); };
});
const state = toScopedSignal(source, { destroyRef: owner, initialValue: 0 });
const doubled = native.computed(() => state() * 2);
assert.equal(native.isSignal(state), true);
subject.next(3);
assert.equal(doubled(), 6);
const correct: number = state();
// @ts-expect-error Packed signal element types cannot silently become any.
const incorrect: string = state();
void correct; void incorrect;
const registrations = teardowns.size;
const invalid = native.computed(() => toScopedSignal(source, { destroyRef: owner, initialValue: 0 }));
assert.throws(() => invalid());
assert.equal(subscriptions, 1, "Invalid reactive nesting must not start an extra subscription");
assert.equal(teardowns.size, registrations, "Invalid nesting must not leak an owner registration");
controller.abort();
assert.equal(releases, 1);
subject.next(5);
assert.equal(doubled(), 6);
assert.equal(teardowns.size, 0);
source.pipe(takeUntilDestroyed(owner)).subscribe();
assert.equal(subscriptions, 1, "An already-aborted owner cannot start cold work");
const completed = toScopedSignal(source, { destroyRef: owner, initialValue: 9 });
assert.equal(completed(), 9);
assert.equal(subscriptions, 1);
subject.complete();
console.log("Packed Angular identity, state, ownership, misuse and teardown passed (production=" + process.argv.includes("--production") + ")");
`;
}

function httpConsumerSource(): string {
  return `import { strict as assert } from "node:assert";
import { HttpClient as RootClient, createEnvironmentInjector } from "@supacloud/app";
import { HttpClient, provideHttpClient, withFetch, withInterceptors, withRequestsMadeViaParent } from "@supacloud/app/http";
import { createHttpTestBackend } from "@supacloud/testing";
import { createPendingWorkRegistry } from "@supacloud/app/runtime";
assert.equal(HttpClient, RootClient, "HTTP entry must share the root client identity");
const backend = createHttpTestBackend();
const order: string[] = [];
const parent = createEnvironmentInjector([provideHttpClient(withFetch(backend.fetch), withInterceptors(async (req, next) => {
  order.push("parent"); return next(req);
}))]);
const child = createEnvironmentInjector([provideHttpClient(withRequestsMadeViaParent(), withInterceptors(async (req, next) => {
  order.push("child"); return next(req);
}))], parent);
try {
  await parent.initialize(); await child.initialize();
  const result = child.get(HttpClient).get("https://fixture.test/orders");
  const request = backend.expectOne("https://fixture.test/orders");
  request.flush({ ok: true });
  assert.deepEqual(await result, { ok: true });
  assert.deepEqual(order, ["child", "parent"]);
  backend.verify();
  const owner = new AbortController();
  const callbacks = new Set<() => void | Promise<void>>();
  const work = createPendingWorkRegistry({ signal: owner.signal, onDestroy(fn) { callbacks.add(fn); return () => { callbacks.delete(fn); }; } });
  assert.equal(await work.run({ name: "request.read", kind: "request" }, () => 7), 7);
  const error = new Error("synthetic failure");
  await assert.rejects(work.run({ name: "request.read", kind: "request" }, () => { throw error; }), e => e === error);
  await work.waitForIdle(); owner.abort();
  assert.equal(work.closed, true); assert.equal(callbacks.size, 0);
} finally { backend.dispose(); await child.destroyAsync(); await parent.destroyAsync(); }
console.log("Packed HTTP identity, actual injector hierarchy, request verification and work ownership passed");
`;
}
