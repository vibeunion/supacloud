import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("compiled database bootstrap loads the canonical schema without a source checkout", () => {
  const directory = mkdtempSync(join(tmpdir(), "supacloud-bootstrap-compiled-"));
  const executable = join(directory, process.platform === "win32" ? "bootstrap.exe" : "bootstrap");
  const fixture = resolve(import.meta.dir, "../fixtures/database-bootstrap-process.ts");
  try {
    const build = spawnSync(process.execPath, [
      "build", fixture, "--compile", `--outfile=${executable}`,
    ], {
      encoding: "utf8", timeout: 60_000,
    });
    expect(build.status, build.stderr).toBe(0);
    if (process.platform === "darwin") {
      const sign = spawnSync("codesign", ["--force", "--sign", "-", executable], {
        encoding: "utf8", timeout: 15_000,
      });
      expect(sign.status, sign.stderr).toBe(0);
    }
    const run = spawnSync(executable, ["--schema-only"], {
      cwd: directory, encoding: "utf8", timeout: 15_000,
      env: { ...process.env, SUPABASE_SCHEMA_PATH: join(directory, "absent.sql") },
    });
    expect(run.status, run.stderr || String(run.error ?? run.signal)).toBe(0);
    const schema = readFileSync(resolve(import.meta.dir, "../../src/db/schemas/supabase.sql"));
    expect(JSON.parse(run.stdout.trim())).toEqual({
      embeddedSchema: true, sha256: createHash("sha256").update(schema).digest("hex"),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 80_000);
