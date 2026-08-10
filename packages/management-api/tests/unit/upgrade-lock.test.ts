import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    acquireSupaCloudUpgradeLock,
    buildUpgradeLockScript,
} from "../../src/upgrade-lock";

async function waitForFile(filePath: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (existsSync(filePath)) return;
        await Bun.sleep(20);
    }
    throw new Error(`Timed out waiting for ${filePath}`);
}

describe("SupaCloud upgrade lock", () => {
    test("uses a nonblocking conflict exit for the inherited shell descriptor", () => {
        const script = buildUpgradeLockScript("/run/lock/supacloud-upgrade.lock");

        expect(script).toContain("exec 9<>");
        expect(script).toContain("flock -E 75 -n 9");
        expect(script).toContain("export SUPACLOUD_UPGRADE_LOCK_FD=9");
        expect(script).toContain("Another SupaCloud upgrade is already running");
        expect(Bun.spawnSync(["bash", "-n", "-c", script]).exitCode).toBe(0);
    });

    test("serializes direct Management upgrade processes", () => {
        if (process.platform !== "linux" || !Bun.which("flock")) return;
        const fixtureRoot = mkdtempSync(join(tmpdir(), "supacloud-management-lock-"));
        const lockPath = join(fixtureRoot, "upgrade.lock");
        const firstLock = acquireSupaCloudUpgradeLock(lockPath);
        try {
            expect(() => acquireSupaCloudUpgradeLock(lockPath))
                .toThrow("Another SupaCloud upgrade is already running");
        } finally {
            firstLock.release();
        }

        const nextLock = acquireSupaCloudUpgradeLock(lockPath);
        nextLock.release();
        rmSync(fixtureRoot, { recursive: true, force: true });
    });

    test("reuses the Admin shell lock in a compiled Management executable", async () => {
        if (process.platform !== "linux" || !Bun.which("flock")) return;
        const fixtureRoot = mkdtempSync(join(tmpdir(), "supacloud-inherited-lock-"));
        const lockPath = join(fixtureRoot, "upgrade.lock");
        const readyPath = join(fixtureRoot, "ready");
        const releasePath = join(fixtureRoot, "release");
        const helperSourcePath = join(fixtureRoot, "lock-helper.ts");
        const helperBinaryPath = join(fixtureRoot, "lock-helper");
        const modulePath = join(import.meta.dir, "../../src/upgrade-lock.ts");
        writeFileSync(helperSourcePath, [
            `import { acquireSupaCloudUpgradeLock } from ${JSON.stringify(modulePath)};`,
            'import { existsSync, writeFileSync } from "node:fs";',
            "const upgradeLock = acquireSupaCloudUpgradeLock(process.env.LOCK_PATH!);",
            'writeFileSync(process.env.READY_PATH!, "ready");',
            "for (let attempt = 0; attempt < 500; attempt += 1) {",
            "    if (existsSync(process.env.RELEASE_PATH!)) break;",
            "    if (attempt === 499) throw new Error(\"Timed out waiting for lock release\");",
            "    await Bun.sleep(20);",
            "}",
            "upgradeLock.release();",
        ].join("\n"));
        const compilation = Bun.spawnSync([
            "bun", "build", helperSourcePath, "--compile", "--outfile", helperBinaryPath,
        ]);
        const shell = [
            buildUpgradeLockScript(lockPath),
            '"$LOCK_HELPER"',
        ].join("\n");
        const execution = Bun.spawn(["bash", "-c", shell], {
            env: {
                ...process.env,
                LOCK_HELPER: helperBinaryPath,
                LOCK_PATH: lockPath,
                READY_PATH: readyPath,
                RELEASE_PATH: releasePath,
            },
            stdout: "pipe",
            stderr: "pipe",
        });
        try {
            expect(compilation.exitCode).toBe(0);
            await waitForFile(readyPath);
            expect(() => acquireSupaCloudUpgradeLock(lockPath))
                .toThrow("Another SupaCloud upgrade is already running");
            writeFileSync(releasePath, "release");
            expect(await execution.exited).toBe(0);
            expect(await new Response(execution.stderr).text()).toBe("");
        } finally {
            writeFileSync(releasePath, "release");
            execution.kill("SIGTERM");
            rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });
});
