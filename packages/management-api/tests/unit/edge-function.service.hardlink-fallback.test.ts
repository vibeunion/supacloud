import { afterAll, expect, mock, test } from "bun:test";
import * as realFs from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

// Force `fs.link` to fail so the immutable-artifact dedup takes its fallback
// path: write a separate copy and make it read-only. The service must still
// deploy successfully when the filesystem cannot hardlink.
const functionsRoot = await mkdtemp(join(homedir(), ".supacloud-edge-functions-fallback-"));
process.env.EDGE_FUNCTIONS_DIR = functionsRoot;
process.env.EDGE_RUNTIME_INTERNAL = "127.0.0.1:65535";

let linkAttempts = 0;
mock.module("fs/promises", () => ({
  ...realFs,
  default: {
    ...realFs,
    link: async () => {
      linkAttempts += 1;
      throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    },
  },
}));

const { edgeFunctionService } = await import("../../src/services/edge-function.service");

afterAll(async () => {
  await rm(functionsRoot, { recursive: true, force: true });
});

test("falls back to a read-only separate copy when hardlinking is unavailable", async () => {
  const code = "export default { fetch: () => new Response('fallback') };";
  const staged = await edgeFunctionService.stageVersion({
    ref: "proj_hardlink_fallback",
    slug: "fallback",
    code,
    prebundled: true,
    expectedSha256: createHash("sha256").update(code).digest("hex"),
  });

  expect(linkAttempts).toBeGreaterThan(0);

  const versionDir = join(
    functionsRoot,
    "proj_hardlink_fallback",
    ".versions",
    "fallback",
    staged.version,
  );
  const authority = join(versionDir, `index.${staged.artifact_sha256.slice(0, 16)}.js`);
  const runtimeEntry = join(versionDir, "src", ".supacloud-entry.js");
  // The prebundled path's attested source is not chmodded by its caller, so it
  // only becomes read-only if the fallback copy itself is made read-only.
  const source = join(versionDir, "index.src.ts");
  expect(existsSync(runtimeEntry)).toBe(true);
  expect(existsSync(source)).toBe(true);

  const authorityStat = await stat(authority);
  const runtimeStat = await stat(runtimeEntry);
  const sourceStat = await stat(source);
  // The fallback wrote distinct files rather than hardlinks...
  expect(runtimeStat.ino).not.toBe(authorityStat.ino);
  expect(sourceStat.ino).not.toBe(authorityStat.ino);
  // ...with identical bytes and the same read-only mode as the authority.
  expect(await readFile(runtimeEntry)).toEqual(await readFile(authority));
  expect(await readFile(source)).toEqual(await readFile(authority));
  expect(runtimeStat.mode & 0o222).toBe(0);
  expect(sourceStat.mode & 0o222).toBe(0);
  expect(authorityStat.mode & 0o222).toBe(0);
});