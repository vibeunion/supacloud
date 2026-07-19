import { afterEach, describe, expect, test } from "bun:test";
import {
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    installSkill,
    resolveBundledSkillDirectory,
    resolveDefaultCodexSkillRoot,
} from "./ai-tools";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function temporaryDirectory(prefix: string): string {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

function createSourceSkill(): string {
    const sourceDirectory = temporaryDirectory("supacloud-skill-source-");
    mkdirSync(join(sourceDirectory, "references"));
    writeFileSync(join(sourceDirectory, "SKILL.md"), "# SupaCloud CLI\n");
    writeFileSync(join(sourceDirectory, "references", "database-workflow.md"), "migration-first\n");
    return sourceDirectory;
}

describe("SupaCloud CLI AI skill installer", () => {
    test("resolves the bundled skill and the default Codex skill root", () => {
        const codexHome = join(tmpdir(), "codex-home");
        const homeDirectory = join(tmpdir(), "home");
        expect(resolveBundledSkillDirectory()).toEndWith(join("packages", "cli", "skills", "supacloud-cli"));
        expect(resolveDefaultCodexSkillRoot({ CODEX_HOME: codexHome }, homeDirectory))
            .toBe(join(resolve(codexHome), "skills"));
        expect(resolveDefaultCodexSkillRoot({}, homeDirectory))
            .toBe(join(resolve(homeDirectory, ".codex"), "skills"));
    });

    test("reports a new installation during dry-run without writing files", () => {
        const sourceDirectory = createSourceSkill();
        const targetRoot = temporaryDirectory("supacloud-skill-target-");

        const summary = installSkill({
            sourceDirectory,
            targetRoot,
            mode: "dry-run",
            conflictPolicy: "reject",
            now: new Date("2026-07-18T12:34:56.789Z"),
        });

        expect(summary.action).toBe("create");
        expect(summary.changed).toBe(true);
        expect(summary.backupDirectory).toBeNull();
        expect(summary.files).toEqual(["SKILL.md", "references/database-workflow.md"]);
        expect(existsSync(join(targetRoot, "supacloud-cli"))).toBe(false);
    });

    test("installs idempotently and rejects unapproved replacement", () => {
        const sourceDirectory = createSourceSkill();
        const targetRoot = temporaryDirectory("supacloud-skill-target-");
        const request = {
            sourceDirectory,
            targetRoot,
            mode: "write" as const,
            conflictPolicy: "reject" as const,
            now: new Date("2026-07-18T12:34:56.789Z"),
        };

        const installed = installSkill(request);
        const unchanged = installSkill(request);
        writeFileSync(join(targetRoot, "supacloud-cli", "SKILL.md"), "user-owned change\n");

        expect(installed.action).toBe("create");
        expect(readFileSync(join(targetRoot, "supacloud-cli", "SKILL.md"), "utf8"))
            .toBe("user-owned change\n");
        expect(unchanged.action).toBe("none");
        expect(unchanged.changed).toBe(false);
        expect(() => installSkill(request)).toThrow("already exists with different content");
    });

    test("backs up different content before an approved replacement", () => {
        const sourceDirectory = createSourceSkill();
        const targetRoot = temporaryDirectory("supacloud-skill-target-");
        installSkill({
            sourceDirectory,
            targetRoot,
            mode: "write",
            conflictPolicy: "reject",
            now: new Date("2026-07-18T12:34:56.789Z"),
        });
        writeFileSync(join(targetRoot, "supacloud-cli", "SKILL.md"), "user-owned change\n");

        const summary = installSkill({
            sourceDirectory,
            targetRoot,
            mode: "write",
            conflictPolicy: "replace",
            now: new Date("2026-07-18T12:34:56.789Z"),
        });

        expect(summary.action).toBe("replace");
        expect(summary.backupDirectory).toEndWith("supacloud-cli.backup-20260718T123456789Z");
        expect(readFileSync(join(summary.backupDirectory!, "SKILL.md"), "utf8"))
            .toBe("user-owned change\n");
        expect(readFileSync(join(targetRoot, "supacloud-cli", "SKILL.md"), "utf8"))
            .toBe("# SupaCloud CLI\n");
    });
});
