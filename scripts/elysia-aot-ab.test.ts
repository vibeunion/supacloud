import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { platformBuildEnvironment } from "./elysia-aot-ab";

describe("platform AOT capture isolation", () => {
  test("does not pass operator credentials or config paths to the capture process", () => {
    const previous = process.env["SUPACLOUD_AOT_TEST_SECRET"];
    process.env["SUPACLOUD_AOT_TEST_SECRET"] = "must-not-inherit";
    try {
      const scratch = join(tmpdir(), "platform-aot-environment-test");
      const env = platformBuildEnvironment(scratch);
      expect(env["SUPACLOUD_AOT_TEST_SECRET"]).toBeUndefined();
      expect(env["MASTER_TOKEN"]).toBeUndefined();
      expect(env["JWT_SECRET"]).toBeUndefined();
      expect(env["BUN_OPTIONS"]).toBeUndefined();
      expect(env["NODE_OPTIONS"]).toBeUndefined();
      expect(env["NODE_ENV"]).toBe("test");
      expect(env["DATABASE_URL"]).toBe("postgres://aot:aot@127.0.0.1:1/aot");
      expect(env["SUPACLOUD_MANAGEMENT_ENV_FILE"]).toBe(join(scratch, "absent-management.env"));
      expect(env["SUPACLOUD_LOCAL_ENV_FILE"]).toBe(join(scratch, "absent-local.env"));
      expect(env["SUPACLOUD_LEGACY_CONFIG_ENV_FILE"]).toBe(join(scratch, "absent-legacy.env"));
    } finally {
      if (previous === undefined) delete process.env["SUPACLOUD_AOT_TEST_SECRET"];
      else process.env["SUPACLOUD_AOT_TEST_SECRET"] = previous;
    }
  });

  test("Edge capture exports routes without starting Workers, listeners or Function directories", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "platform-aot-edge-test-"));
    try {
      const entry = resolve(import.meta.dir, "../packages/edge-runtime/server.ts");
      const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", `
        globalThis.Worker = class { constructor() { throw new Error("capture started a Worker"); } };
        Bun.serve = () => { throw new Error("capture started a listener"); };
        const { app } = await import(${JSON.stringify(entry)});
        if (!app || app["~routes"].length === 0) throw new Error("capture did not export routes");
        console.log("CAPTURE_OK");
        process.exit(0);
      `], {
        cwd: scratch,
        env: { ...platformBuildEnvironment(scratch), ELYSIA_AOT_BUILD: "1" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15_000,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(exitCode, stderr).toBe(0);
      expect(stdout).toContain("CAPTURE_OK");
      expect(existsSync(join(scratch, "functions"))).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);
});
