import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOOD_PROJECT_FILES } from "./fixtures/good-project";
import { writeFixtureProject } from "./fixtures/helpers";
import { watchProject } from "./watch";
import type { WatchHandle } from "./types";

const roots: string[] = [];
const handles: WatchHandle[] = [];
async function bounded<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}
async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), "supacloud-watch-lifecycle-"));
  roots.push(rootDir);
  await writeFixtureProject(rootDir, GOOD_PROJECT_FILES);
  return { rootDir, outDir: join(rootDir, "generated"), debounceMs: 10 };
}
afterEach(async () => {
  for (const handle of handles.splice(0)) await bounded(handle.close(), "cleanup timed out").catch(() => {});
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("watch lifecycle", () => {
  test("closing during initial compilation settles both ready and close", async () => {
    const handle = watchProject(await fixture());
    handles.push(handle);
    await bounded(Promise.all([handle.ready, handle.close()]), "early close left ready pending");
  });

  test("watch setup errors reject ready rather than leaving it pending", async () => {
    const options = await fixture();
    const handle = watchProject({ ...options, onEvent(event) {
      if (event.initial && event.type === "compiled") rmSync(options.rootDir, { recursive: true, force: true });
    } });
    handles.push(handle);
    let failure: unknown;
    try { await bounded(handle.ready, "watch setup left ready pending"); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("left ready pending");
    await bounded(handle.close(), "setup failure left close pending");
  });

  test("close waits for an already running recompile before returning", async () => {
    const options = await fixture();
    let completed = false;
    let requestClose: () => void = () => {};
    const closingRequested = new Promise<void>(resolve => { requestClose = resolve; });
    let closing: Promise<void> | undefined;
    const handle = watchProject({ ...options, onEvent(event) {
      if (!event.initial && event.type === "compile-start") {
        closing = handle.close();
        requestClose();
      }
      if (!event.initial && event.type === "compiled") completed = true;
    } });
    handles.push(handle);
    await handle.ready;
    await appendFile(join(options.rootDir, "src/features/health/health.module.ts"), "\n");
    await bounded(closingRequested, "source edit was not observed");
    await bounded(closing!, "running recompile did not drain");
    expect(completed).toBe(true);
  }, 15_000);

  test("initial observer failures reject ready and still allow cleanup", async () => {
    const failure = new Error("observer failure");
    const handle = watchProject({ ...await fixture(), onEvent() { throw failure; } });
    handles.push(handle);
    await expect(handle.ready).rejects.toBe(failure);
    await bounded(handle.close(), "observer failure left close pending");
  });

  test("unexpected rebuild failures are redacted and a later edit can recover", async () => {
    const options = await fixture();
    let failedOnce = false;
    let resolveFailed: () => void = () => {};
    let resolveRecovered: () => void = () => {};
    const failed = new Promise<void>(resolve => { resolveFailed = resolve; });
    const recovered = new Promise<void>(resolve => { resolveRecovered = resolve; });
    const diagnostics: string[] = [];
    const handle = watchProject({ ...options, onEvent(event) {
      if (!event.initial && event.type === "compile-start" && !failedOnce) {
        failedOnce = true;
        throw new Error("private-configuration-sentinel");
      }
      if (!event.initial && event.type === "compile-error") {
        diagnostics.push(JSON.stringify(event));
        resolveFailed();
      }
      if (!event.initial && event.type === "compiled") resolveRecovered();
    } });
    handles.push(handle);
    await handle.ready;
    const path = join(options.rootDir, "src/features/health/health.module.ts");
    await appendFile(path, "\n");
    await bounded(failed, "unexpected exception was not reported");
    expect(diagnostics.join("")).toContain("watch-compile");
    expect(diagnostics.join("")).not.toContain("private-configuration-sentinel");
    await appendFile(path, "\n");
    await bounded(recovered, "watcher did not recover");
  }, 15_000);
});
