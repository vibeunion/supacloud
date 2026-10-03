import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localDatabaseUrl, runLocalDevelopment } from "./app-local-dev";

const roots: string[] = [];
async function fixture(source: string, scripts: Record<string, string> = { dev: "bun --no-env-file server.ts" }) {
  const root = await mkdtemp(join(tmpdir(), "app-local-dev-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts }));
  await writeFile(join(root, "server.ts"), source);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

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
