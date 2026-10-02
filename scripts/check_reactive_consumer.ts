/** Validate published entrypoints from candidate tarballs outside the workspace. */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installStarterConsumer, runStarterCommand } from "./check_app_starter";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "supacloud-reactive-consumer-"));
const project = join(temporary, "consumer");
const interruption = new AbortController();
const interrupt = () => interruption.abort(new Error("Reactive consumer verification interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !/^(SUPACLOUD_|SUPABASE_|APP_ENV$|NODE_ENV$|PORT$|NODE_PATH$)/.test(key)) env[key] = value;
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
  for (const directory of ["contracts", "app", "supacloud-js"]) {
    const root = join(repo, "packages", directory);
    const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    await readFile(join(root, "dist/index.js"));
    if (directory !== "contracts") await readFile(join(root, "dist/reactive.d.ts"));
    await run(["pm", "pack", "--ignore-scripts", "--destination", temporary], root);
    const prefix = `${String(metadata.name).replace(/^@/, "").replaceAll("/", "-")}-`;
    const packed = (await readdir(temporary)).find(file => file.startsWith(prefix) && file.endsWith(".tgz"));
    assert.ok(packed, `Missing candidate ${metadata.name}`);
    overrides[metadata.name] = `file:${join(temporary, packed)}`;
  }
  const app = JSON.parse(await readFile(join(repo, "packages/app/package.json"), "utf8"));
  const sdk = JSON.parse(await readFile(join(repo, "packages/supacloud-js/package.json"), "utf8"));
  assert.equal(app.dependencies.rxjs, sdk.dependencies.rxjs);
  await writeFile(join(project, "package.json"), JSON.stringify({
    name: "reactive-consumer", private: true, type: "module",
    dependencies: {
      ...overrides,
      rxjs: sdk.dependencies.rxjs,
      "@supabase/supabase-js": sdk.peerDependencies["@supabase/supabase-js"],
    },
    devDependencies: {
      typescript: sdk.devDependencies.typescript,
      "@types/node": app.devDependencies["@types/node"],
    },
    overrides,
  }, null, 2));
  // The native SDK requires DOM declarations even for a NodeNext consumer.
  // Keep full declaration checking. A native-only baseline distinguishes the
  // peer's known WebAuthn defect from errors introduced by our packed adapters.
  const compilerOptions = {
    target: "ES2022", lib: ["ES2022", "DOM", "DOM.Iterable"],
    module: "NodeNext", moduleResolution: "NodeNext", types: ["node"],
    strict: true, skipLibCheck: false, noEmit: true,
  };
  for (const [name, file] of [
    ["tsconfig.json", "consumer.ts"],
    ["tsconfig.native.json", "native.ts"],
    ["tsconfig.framework.json", "framework.ts"],
  ]) {
    await writeFile(join(project, name!), JSON.stringify({ compilerOptions, include: [file] }, null, 2));
  }
  await writeFile(join(project, "native.ts"), 'import { createClient } from "@supabase/supabase-js";\nvoid createClient;\n');
  await writeFile(join(project, "framework.ts"), `import { of } from "rxjs";
import { takeUntilAborted, toReadableStream } from "@supacloud/app/reactive";
const stream: ReadableStream<number> = toReadableStream(of(1).pipe(takeUntilAborted(new AbortController().signal)));
// @ts-expect-error Framework stream element inference remains precise.
const wrong: ReadableStream<string> = stream;
void wrong;
`);
  await writeFile(join(project, "strict-declarations.mjs"), declarationCheckSource());
  await writeFile(join(project, "consumer.ts"), consumerSource());
  await writeFile(join(project, "browser.ts"), `export { observeQuery, observeTask } from "@supacloud/js/reactive";
export { takeUntilAborted, toReadableStream } from "@supacloud/app/reactive";
`);
  await writeFile(join(project, "bundle.mjs"), `import { strict as assert } from "node:assert";
const result = await Bun.build({ entrypoints: ["./browser.ts"], target: "browser", metafile: true });
assert.equal(result.success, true);
assert.ok(result.metafile);
const inputs = Object.keys(result.metafile.inputs);
assert.ok(inputs.some(path => path.includes("rxjs")));
assert.ok(!inputs.some(path => /angular|node:async_hooks|\\/compiler\\//.test(path)));
assert.ok(!inputs.some(path => path.endsWith("@supacloud/js/dist/index.js")));
console.log("Packed reactive browser entries retain dependency isolation");
`);
  await installStarterConsumer(project, run);
  console.log(await run(["consumer.ts"]));
  console.log(await run(["bundle.mjs"]));
  console.log(await run(["strict-declarations.mjs"]));
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await rm(temporary, { recursive: true, force: true });
}

function declarationCheckSource(): string {
  return String.raw`import { strict as assert } from "node:assert";
async function compile(project) {
  const child = Bun.spawn([process.execPath, "node_modules/typescript/bin/tsc", "--project", project, "--pretty", "false"], {
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  assert.ok(code === 0 || code === 1, "TypeScript did not complete normally: " + stdout + stderr);
  return { code, diagnostics: (stdout + stderr).trim() };
}
const framework = await compile("tsconfig.framework.json");
assert.equal(framework.code, 0, framework.diagnostics);
console.log("Packed framework reactive declarations pass strict full-library checking");
const native = await compile("tsconfig.native.json");
const consumer = await compile("tsconfig.json");
if (native.code === 0) {
  assert.equal(consumer.code, 0, consumer.diagnostics);
  console.log("Packed SDK consumer declarations pass strict full-library checking");
} else {
  // Only this independently reproduced peer diagnostic is recognized. Do not
  // accept arbitrary native failures, additional errors, or patched declarations.
  const headers = native.diagnostics.match(/^.+\(\d+,\d+\): error TS\d+:.*$/gm) ?? [];
  assert.equal(headers.length, 1, native.diagnostics);
  assert.match(headers[0], /^node_modules\/@supabase\/auth-js\/dist\/module\/lib\/webauthn\.dom\.d\.ts\(\d+,\d+\): error TS2430: Interface 'PublicKeyCredentialFuture<T>' incorrectly extends interface 'PublicKeyCredential'\.$/);
  assert.match(native.diagnostics, /toJSON/);
  assert.match(native.diagnostics, /ArrayBuffer/);
  assert.equal(consumer.code, native.code, consumer.diagnostics);
  assert.equal(consumer.diagnostics, native.diagnostics, "Packed adapters introduced additional/different diagnostics:\n" + consumer.diagnostics);
  console.log("::warning::Native Supabase SDK independently reproduces its WebAuthn/DOM TS2430 defect. Full SDK strict declaration acceptance remains blocked upstream; packed adapters add no diagnostics. No skipLibCheck or declaration patch was used.");
  console.log(native.diagnostics);
}
`;
}

function consumerSource(): string {
  return `import { strict as assert } from "node:assert";
import { createClient } from "@supabase/supabase-js";
import { createSupaCloudClient, SupaCloudTaskDecoderError } from "@supacloud/js";
import { observeQuery, observeTask } from "@supacloud/js/reactive";
import { takeUntilAborted, toReadableStream } from "@supacloud/app/reactive";
import { Observable, firstValueFrom, lastValueFrom, of } from "rxjs";

type Database = { public: { Tables: { widgets: {
  Row: { id: string; label: string }; Insert: { id: string; label: string };
  Update: { label?: string }; Relationships: [];
} }; Views: {}; Functions: {}; Enums: {}; CompositeTypes: {} } };
const taskId = "task-reactive-1";
let submits = 0, queries = 0;
const supabase = createClient<Database>("https://project.example.test", "fixture-key", {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === "/functions/v1/render") {
      submits++;
      assert.equal(request.method, "POST");
      return Response.json({ task_id: taskId, project_ref: "project-a", status: "pending" }, { status: 202 });
    }
    queries++;
    assert.equal(request.method, "GET");
    assert.equal(new URL(request.url).pathname, "/rest/v1/widgets");
    return Response.json([{ id: "one" }], { headers: { "content-range": "0-0/1" } });
  } },
});
const client = createSupaCloudClient({
  supabase, projectRef: "project-a", managementApiUrl: "https://management.example.test",
  getAccessToken: () => "synthetic-project-token",
});
assert.equal(client.supabase, supabase);
const rows = observeQuery(signal => client.supabase.from("widgets").select("id", { count: "exact" }).abortSignal(signal));
assert.equal(queries, 0);
const response = await firstValueFrom(rows);
assert.deepEqual(response.data, [{ id: "one" }]);
assert.equal(response.count, 1);
const rowId: string | undefined = response.data?.[0]?.id;
// @ts-expect-error Selected IDs remain strings, not any.
const numericId: number | undefined = response.data?.[0]?.id;
// @ts-expect-error Unselected columns do not appear in the query contract.
const unselected = response.data?.[0]?.label;
void rowId; void numericId; void unselected;
assert.equal((await client.supabase.from("widgets").select("id")).error, null);
assert.equal(queries, 2);

let reads = 0;
let project = "project-a";
let value: unknown = { total: 7 };
const previousFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  reads++;
  const request = new Request(input, init);
  assert.equal(request.method, "GET", "observation must never call cancel/retry/submit");
  assert.equal(new URL(request.url).pathname, "/v1/projects/project-a/tasks/" + taskId);
  assert.equal(request.headers.get("authorization"), "Bearer synthetic-project-token");
  return Response.json({ id: taskId, project_ref: project, status: "completed", result: value });
};
try {
  const decode = (input: unknown): { total: number } => {
    if (input === null || typeof input !== "object" || !("total" in input) || typeof input.total !== "number") {
      throw new Error("invalid fixture result");
    }
    return { total: input.total };
  };
  const receipt = await client.tasks.submitTyped("render", { body: { test: true } }, decode);
  assert.equal(submits, 1);
  const progress = observeTask(receipt);
  assert.equal(reads, 0);
  const first = await lastValueFrom(progress);
  const second = await lastValueFrom(progress);
  assert.equal(first.raw.result?.total, 7);
  assert.equal(second.raw.result?.total, 7);
  // @ts-expect-error Typed task decoder inference is preserved across the Observable.
  const wrongResult: string | undefined = first.raw.result?.total;
  void wrongResult;
  assert.equal(reads, 2);
  assert.equal(submits, 1, "resubscribing must not submit another task");
  assert.equal((await receipt.get()).result?.total, 7);
  value = { total: "invalid" };
  await assert.rejects(lastValueFrom(progress), SupaCloudTaskDecoderError);
  value = { total: 7 };
  project = "foreign-project";
  await assert.rejects(lastValueFrom(progress));
  assert.equal(submits, 1);
} finally { globalThis.fetch = previousFetch; }

let release = 0;
const owner = new AbortController();
const ongoing = new Observable<number>(() => () => { release++; });
ongoing.pipe(takeUntilAborted(owner.signal)).subscribe();
owner.abort();
assert.equal(release, 1);
const reader = toReadableStream(of(1, 2), { capacity: 2 }).getReader();
assert.deepEqual(await reader.read(), { value: 1, done: false });
assert.deepEqual(await reader.read(), { value: 2, done: false });
assert.equal((await reader.read()).done, true);
console.log("Packed SDK: native queries, one task submission with repeated observation, decoder/project rejection and cleanup passed");
`;
}
