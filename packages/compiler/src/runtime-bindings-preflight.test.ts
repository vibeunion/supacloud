import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("runtime production preflight happens before project configuration can execute", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-binding-preflight-"));
  const marker = join(root, "config-was-executed");
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  try {
    await writeFile(join(root, "supacloud.config.ts"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\nthrow new Error("private-config-sentinel");\n`);
    const child = Bun.spawn([process.execPath, "--no-env-file", cli, "environment-bindings", "--environment", "production", "--profile", "integration"], {
      cwd: root, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe",
    });
    const deadline = setTimeout(() => child.kill(), 10_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code).toBe(1);
      expect(stderr).toContain("ENVIRONMENT_BINDINGS_PRODUCTION_FORBIDDEN");
      expect(stdout + stderr).not.toContain("private-config-sentinel");
      expect(existsSync(marker)).toBe(false);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) { child.kill(); await child.exited; }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
