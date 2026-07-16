import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "../..");
const cliEntry = resolve(packageRoot, "src/index.ts");

describe("project CLI help", () => {
  test("project create --help prints help without starting the create prompt", () => {
    const result = spawnSync(
      process.execPath,
      [cliEntry, "project", "create", "--help"],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
        timeout: 10_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("supacloud project create");
    expect(result.stdout).not.toContain("Enter project name");
  }, { timeout: 15_000 });
});
