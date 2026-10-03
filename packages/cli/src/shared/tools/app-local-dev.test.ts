import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localDatabaseUrl, runLocalDevelopment } from "./app-local-dev";

const roots: string[] = [];
async function fixture(source: string, scripts: Record<string, string> = { dev: "bun --no-env-file server.ts" }) {
  const root = await mkdtemp(join(tmpdir(), "app-local-dev-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", scripts }));
  await writeFile(join(root, "server.ts"), source);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("local dev bundles for Node and does not require Bun until integration runs", async () => {
  const root = await fixture("");
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "app-local-dev.ts")],
    target: "node", outdir: root,
  });
  expect(result.success).toBe(true);
  const child = Bun.spawn(["node", "--input-type=module", "-e",
    `import { localDatabaseUrl } from ${JSON.stringify(join(root, "app-local-dev.js"))};
     if (!localDatabaseUrl("postgresql://localhost/dev")) process.exit(1);`],
    { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ code, errors: code ? stdout + stderr : "" }).toEqual({ code: 0, errors: "" });
});

test("Node integration reaches the Bun database preflight and fails closed without leaking credentials", async () => {
  const root = await fixture('console.log("MUST_NOT_START")', {
    "dev:integration": "bun --no-env-file server.ts",
  });
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "app-local-dev.ts")], target: "node", outdir: root,
  });
  expect(build.success).toBe(true);
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = listener.port;
  await listener.stop(true);
  const child = Bun.spawn(["node", "--input-type=module", "-e", `
    import { runLocalDevelopment } from ${JSON.stringify(join(root, "app-local-dev.js"))};
    try {
      await runLocalDevelopment({ root: ${JSON.stringify(root)}, profile: "integration",
        databaseUrl: process.env.SUPACLOUD_DEV_DATABASE_URL, onOutput: text => console.log(text) });
      process.exitCode = 1;
    } catch (error) {
      if (!error.message.startsWith("Integration database verification failed;")) throw error;
      console.log("PREFLIGHT_REJECTED");
    }`], {
    env: { ...process.env, APP_ENV: "development", SUPACLOUD_ENV: "test",
      SUPACLOUD_DEV_DATABASE_URL: `postgresql://fixture:private-fixture-secret@127.0.0.1:${port}/fixture` },
    stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "PREFLIGHT_REJECTED\n", stderr: "" });
  } finally { clearTimeout(timeout); }
}, 20_000);

test("dev launches the actual project script, serves HTTP and shuts down on cancellation", async () => {
  const root = await fixture(`
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) });
console.log("READY " + server.url);
`);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 5000);
  let output = "";
  let url: string | undefined;
  const running = runLocalDevelopment({
    root, signal: abort.signal,
    onOutput(text) {
      output += text;
      url = output.match(/READY (http:\/\/127\.0\.0\.1:\d+\/)/)?.[1];
    },
  });
  try {
    for (let attempt = 0; attempt < 100 && !url; attempt++) await Bun.sleep(20);
    expect(url).toBeDefined();
    if (!url) throw new Error(output);
    expect(await (await fetch(url)).json()).toEqual({ ok: true });
  } finally {
    abort.abort();
    clearTimeout(timeout);
    expect(await running).toMatchObject({ exitCode: 0, script: "dev", state: "stopped" });
  }
  if (url) await expect(fetch(url)).rejects.toThrow();
});

test("project failures propagate instead of reporting a successful compile-only session", async () => {
  const root = await fixture("process.exit(7)");
  expect(await runLocalDevelopment({ root })).toMatchObject({ exitCode: 7 });
});

test("a pre-cancelled session never starts application code", async () => {
  const root = await fixture('throw new Error("must not run")');
  const abort = new AbortController();
  abort.abort();
  expect(await runLocalDevelopment({ root, signal: abort.signal })).toMatchObject({ exitCode: 0 });
});

test("missing integration script and unsafe database targets fail before any application code", async () => {
  const root = await fixture('throw new Error("must not run")');
  await expect(runLocalDevelopment({ root, profile: "integration" })).rejects.toThrow("dev:integration");
  for (const url of [
    undefined, "postgresql://user:secret@production.example/db",
    "postgresql://localhost/", "postgresql://localhost/dev?host=production.example",
    "https://localhost/dev", "postgresql://localhost/dev#secret",
  ]) {
    expect(() => localDatabaseUrl(url)).toThrow("explicit loopback");
  }
  expect(localDatabaseUrl("postgresql://local:synthetic@127.0.0.1:5432/dev"))
    .toBe("postgresql://local:synthetic@127.0.0.1:5432/dev");
});

test("output observer failures stop the child and retain the failure", async () => {
  const root = await fixture('console.log("ready"); setInterval(() => {}, 100)');
  const failure = new Error("observer failed");
  await expect(runLocalDevelopment({ root, onOutput() { throw failure; } })).rejects.toBe(failure);
});
