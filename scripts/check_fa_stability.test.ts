import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { digest } from "../packages/delivery/src/delivery-files";
import { verifyFaProofArchive } from "./check_fa_stability";

test("explicit synthetic definitions never claim deployment acceptance", async () => {
  const child = Bun.spawn([
    process.execPath, "--no-env-file", "scripts/check_fa_stability.ts", "--level", "daily",
    "--tuple", "docs/examples/fa-delivery-tuple.fixture.json", "--matrix", "docs/fa-contract-matrix.json",
  ], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ status: "definitions-valid", deployment_verified: false, report_export: "excluded" });
});

test("release has no default evidence or silent fallback to daily checks", async () => {
  const child = Bun.spawn([
    process.execPath, "--no-env-file", "scripts/check_fa_stability.ts", "--level", "release",
    "--tuple", "docs/examples/fa-delivery-tuple.fixture.json", "--matrix", "docs/fa-contract-matrix.json",
  ], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited).toBe(1);
  expect(stderr).toContain("FA_STABILITY_INPUT_OR_ARCHIVE_INVALID");
});

test("archives require real matching bytes and reject missing, tampered, escaping and linked files", async () => {
  const root = await mkdtemp(join(tmpdir(), "fa-stability-archive-"));
  const archive = join(root, "archive");
  try {
    await mkdir(archive);
    const raw = JSON.stringify([{ id: "synthetic" }]);
    await writeFile(join(archive, "observations.json"), raw);
    await writeFile(join(root, "outside.json"), raw);
    await symlink(join(root, "outside.json"), join(archive, "linked.json"));
    const observation = { path: "observations.json", sha256: digest(raw) };
    expect(await verifyFaProofArchive(archive, [observation], observation)).toEqual([{ id: "synthetic" }]);
    for (const path of ["../outside.json", "linked.json", "missing.json"]) {
      await expect(verifyFaProofArchive(archive, [{ path, sha256: digest(raw) }], observation)).rejects.toThrow();
    }
    await expect(verifyFaProofArchive(archive, [{ ...observation, sha256: "f".repeat(64) }], observation)).rejects.toThrow();
    await writeFile(join(archive, "observations.json"), "changed");
    await expect(verifyFaProofArchive(archive, [], observation)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
