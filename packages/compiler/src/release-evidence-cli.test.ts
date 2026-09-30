import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("release evidence CLI never evaluates project configuration and redacts argument and IO errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "release-evidence-cli-"));
  const marker = join(root, "config-was-executed");
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const required = ["--delivery-manifest", "private-path-sentinel.json", "--delivery-target", "api"];
  try {
    await writeFile(join(root, "supacloud.config.ts"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\nthrow new Error("private-config-sentinel");\n`);
    for (const args of [required, [...required, "--write"], [...required, "--root", "private-root"], [...required, "--delivery-target", "other"], ["--delivery-manifest"], []]) {
      const child = Bun.spawn([process.execPath, "--no-env-file", cli, "release-evidence", ...args], {
        cwd: root, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe",
      });
      const deadline = setTimeout(() => child.kill(), 10_000);
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(code).toBe(1);
        expect(stdout).toBe("");
        expect(stderr).toContain("RELEASE_EVIDENCE_INVALID");
        expect(stderr).not.toContain("private-");
        expect(existsSync(marker)).toBe(false);
      } finally {
        clearTimeout(deadline);
        if (child.exitCode === null) { child.kill(); await child.exited; }
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
