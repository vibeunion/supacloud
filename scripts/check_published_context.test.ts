import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runStarterCommand } from "./check_app_starter";
import { verifyPublishedExecutionContext } from "./check_published_customer";
import { prepareStarterSourceFixture } from "./lib/starter-source-fixture";

test("the context consumer gate exercises actual CLI processes and preserves generated drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-context-consumer-"));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("Context consumer test timed out")), 55_000);
  try {
    await prepareStarterSourceFixture(root);
    const home = join(root, "isolated-home");
    await mkdir(home);
    const artifact = join(root, "generated/application.ts");
    const drift = await readFile(artifact, "utf8") + "\n// context must preserve this candidate drift\n";
    await writeFile(artifact, drift);
    const cli = resolve(import.meta.dir, "../packages/cli/src/index.ts");
    const calls: string[][] = [];
    await verifyPublishedExecutionContext(root, cli, (args, success = true) => {
      calls.push(args);
      return runStarterCommand(args, {
        cwd: root, env: { PATH: process.env["PATH"] ?? "", HOME: home },
        signal: abort.signal, timeoutMs: 15_000, success,
      });
    });
    expect(calls).toHaveLength(6);
    expect(calls.some(args => args.includes("--request-id"))).toBe(true);
    expect(calls.some(args => args.includes("--request_id"))).toBe(true);
    expect(calls.filter(args => args.includes("--write"))).toHaveLength(2);
    expect(await readFile(artifact, "utf8")).toBe(drift);
  } finally {
    clearTimeout(timer);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("a missing consumer observer fails without invoking a process or adding a source fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "missing-context-consumer-"));
  let invoked = false;
  try {
    await expect(verifyPublishedExecutionContext(root, "unused-cli", async () => {
      invoked = true;
      return "";
    })).rejects.toThrow();
    expect(invoked).toBe(false);
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
