import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Action help filters fields using their documented action scope. A command can
// otherwise accept a required flag while hiding it from its own --help output.
test("promote-plan action help documents every source, target and output flag without credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "promotion-help-"));
    const env = Object.fromEntries(Object.entries(process.env).filter(
        ([key, value]) => value !== undefined
            && !/^(SUPACLOUD_|SUPABASE_|MANAGEMENT_|X_PROJECT_REF$)/.test(key),
    ));
    const child = Bun.spawn([
        process.execPath, "--no-env-file", fileURLToPath(new URL("../../index.ts", import.meta.url)),
        "app", "promote-plan", "--help",
    ], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
        const [code, stdout, stderr] = await Promise.all([
            child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        expect(code, stderr).toBe(0);
        expect(stdout).toBe("");
        expect(stderr).toContain("app promote-plan [--flags]");
        for (const flag of [
            "ref", "id", "environment_id", "configuration_id",
            "source_ref", "source_release_id", "source_environment_id", "format", "json",
        ]) expect(stderr).toContain(`--${flag}  `);
        expect(stderr).not.toContain("--activation_id  ");
        expect(stderr).not.toContain("--ttl_seconds  ");
    } finally {
        clearTimeout(timeout);
        if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
        await rm(root, { recursive: true, force: true });
    }
}, 20_000);
