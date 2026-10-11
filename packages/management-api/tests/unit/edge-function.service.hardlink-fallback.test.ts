import { expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as realFs from "node:fs/promises";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

async function verifyFallback(functionsRoot: string): Promise<void> {
  const linkTargets: string[] = [];
  const link: typeof realFs.link = async (_source, target) => {
    linkTargets.push(target.toString());
    throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
  };
  mock.module("fs/promises", () => ({
    ...realFs,
    link,
    default: { ...realFs, link },
  }));
  const { logger } = await import("../../src/utils/logger");
  const warning = spyOn(logger, "warn").mockImplementation(() => {});
  const { edgeFunctionService } = await import("../../src/services/edge-function.service");
  const code = "export default { fetch: () => new Response('fallback') };";
  const staged = await edgeFunctionService.stageVersion({
    ref: "proj_hardlink_fallback",
    slug: "fallback",
    code,
    prebundled: true,
    expectedSha256: createHash("sha256").update(code).digest("hex"),
  });

  const versionDir = join(
    functionsRoot,
    "proj_hardlink_fallback",
    ".versions",
    "fallback",
    staged.version,
  );
  const authority = join(versionDir, `index.${staged.artifact_sha256.slice(0, 16)}.js`);
  const runtimeEntry = join(versionDir, "src", ".supacloud-entry.js");
  const source = join(versionDir, "index.src.ts");
  expect(linkTargets.map((target) => basename(target)).sort())
    .toEqual([".supacloud-entry.js", "index.src.ts"]);
  for (const target of [".supacloud-entry.js", "index.src.ts"]) {
    expect(warning).toHaveBeenCalledWith(
      "[EdgeFunction] Immutable artifact dedup unavailable; storing a separate copy",
      { target, error: "EXDEV: cross-device link not permitted" },
    );
  }
  expect(existsSync(runtimeEntry)).toBe(true);
  expect(existsSync(source)).toBe(true);

  const authorityStat = await stat(authority);
  const runtimeStat = await stat(runtimeEntry);
  const sourceStat = await stat(source);
  expect(runtimeStat.ino).not.toBe(authorityStat.ino);
  expect(sourceStat.ino).not.toBe(authorityStat.ino);
  expect(sourceStat.ino).not.toBe(runtimeStat.ino);
  expect(await readFile(authority, "utf8")).toBe(code);
  expect(await readFile(runtimeEntry, "utf8")).toBe(code);
  expect(await readFile(source, "utf8")).toBe(code);
  expect(runtimeStat.mode & 0o222).toBe(0);
  expect(sourceStat.mode & 0o222).toBe(0);
  expect(authorityStat.mode & 0o222).toBe(0);
}

test("falls back to read-only identical copies and warns when hardlinking is unavailable", async () => {
  // Bun module mocks are process-global; run the service in a dedicated test process.
  if (process.env.SUPACLOUD_HARDLINK_FALLBACK_CHILD === import.meta.path) {
    const functionsRoot = process.env.EDGE_FUNCTIONS_DIR;
    if (!functionsRoot) throw new Error("Missing isolated functions directory");
    await verifyFallback(functionsRoot);
    return;
  }

  const functionsRoot = await mkdtemp(join(homedir(), ".supacloud-edge-functions-fallback-"));
  const child = Bun.spawn([process.execPath, "test", import.meta.path], {
    env: {
      ...process.env,
      EDGE_FUNCTIONS_DIR: functionsRoot,
      EDGE_RUNTIME_INTERNAL: "127.0.0.1:65535",
      SUPACLOUD_HARDLINK_FALLBACK_CHILD: import.meta.path,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 10_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`Isolated fallback test failed (${exitCode}):\n${stdout}\n${stderr}`);
    expect(exitCode).toBe(0);
  } finally {
    clearTimeout(timeout);
    child.kill();
    await child.exited;
    await rm(functionsRoot, { recursive: true, force: true });
  }
}, 15_000);
