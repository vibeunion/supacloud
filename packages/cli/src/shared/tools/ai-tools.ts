import {
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { optional, stringEnum } from "../schema";
import type { ToolSchema } from "../schema";
import { registerTool, type ToolServer } from "../tool-server";

const SKILL_NAME = "supacloud";

type InstallMode = "dry-run" | "write";
type ConflictPolicy = "reject" | "replace";
type InstallAction = "create" | "replace" | "none";

interface AiToolArguments {
    action: "show_skill" | "install_skill";
    target?: string;
    dry_run?: boolean;
    force?: boolean;
}

interface InstallSkillRequest {
    sourceDirectory: string;
    targetRoot: string;
    mode: InstallMode;
    conflictPolicy: ConflictPolicy;
    now: Date;
}

export interface SkillInstallSummary {
    name: typeof SKILL_NAME;
    sourceDirectory: string;
    targetRoot: string;
    destinationDirectory: string;
    action: InstallAction;
    mode: InstallMode;
    changed: boolean;
    backupDirectory: string | null;
    files: string[];
}

function regularFiles(rootDirectory: string, currentDirectory = rootDirectory): string[] {
    const files: string[] = [];
    for (const directoryEntry of readdirSync(currentDirectory, { withFileTypes: true })) {
        const entryPath = join(currentDirectory, directoryEntry.name);
        if (directoryEntry.isSymbolicLink()) throw new Error(`Skill directories cannot contain symlinks: ${entryPath}`);
        if (directoryEntry.isDirectory()) files.push(...regularFiles(rootDirectory, entryPath));
        if (directoryEntry.isFile()) files.push(relative(rootDirectory, entryPath).split(sep).join("/"));
    }
    return files.sort();
}

function directoriesMatch(sourceDirectory: string, destinationDirectory: string): boolean {
    if (!existsSync(destinationDirectory) || !lstatSync(destinationDirectory).isDirectory()) return false;
    const sourceFiles = regularFiles(sourceDirectory);
    const destinationFiles = regularFiles(destinationDirectory);
    if (sourceFiles.join("\0") !== destinationFiles.join("\0")) return false;
    return sourceFiles.every((file) => readFileSync(join(sourceDirectory, file))
        .equals(readFileSync(join(destinationDirectory, file))));
}

function backupTimestamp(now: Date): string {
    return now.toISOString().replace(/[-:.]/g, "");
}

function availableBackupDirectory(destinationDirectory: string, now: Date): string {
    const baseDirectory = `${destinationDirectory}.backup-${backupTimestamp(now)}`;
    let candidate = baseDirectory;
    let suffix: number = 2;
    while (existsSync(candidate)) {
        candidate = `${baseDirectory}-${suffix}`;
        suffix += 1;
    }
    return candidate;
}

function stagedSkill(sourceDirectory: string, targetRoot: string): { root: string; skill: string } {
    mkdirSync(targetRoot, { recursive: true });
    const stagingRoot = mkdtempSync(join(targetRoot, ".supacloud-install-"));
    const stagingSkill = join(stagingRoot, SKILL_NAME);
    try {
        cpSync(sourceDirectory, stagingSkill, { recursive: true, errorOnExist: true });
    } catch (error) {
        rmSync(stagingRoot, { recursive: true, force: true });
        throw error;
    }
    return { root: stagingRoot, skill: stagingSkill };
}

function createSkill(sourceDirectory: string, targetRoot: string, destinationDirectory: string): void {
    const staging = stagedSkill(sourceDirectory, targetRoot);
    try {
        renameSync(staging.skill, destinationDirectory);
    } finally {
        rmSync(staging.root, { recursive: true, force: true });
    }
}

function replaceSkill(
    sourceDirectory: string,
    targetRoot: string,
    destinationDirectory: string,
    backupDirectory: string,
): void {
    const staging = stagedSkill(sourceDirectory, targetRoot);
    try {
        renameSync(destinationDirectory, backupDirectory);
        try {
            renameSync(staging.skill, destinationDirectory);
        } catch (error) {
            renameSync(backupDirectory, destinationDirectory);
            throw error;
        }
    } finally {
        rmSync(staging.root, { recursive: true, force: true });
    }
}

function skillSummary(
    request: InstallSkillRequest,
    action: InstallAction,
    files: string[],
    backupDirectory: string | null,
): SkillInstallSummary {
    const sourceDirectory = resolve(request.sourceDirectory);
    const targetRoot = resolve(request.targetRoot);
    return {
        name: SKILL_NAME,
        sourceDirectory,
        targetRoot,
        destinationDirectory: join(targetRoot, SKILL_NAME),
        action,
        mode: request.mode,
        changed: action !== "none",
        backupDirectory,
        files,
    };
}

export function installSkill(request: InstallSkillRequest): SkillInstallSummary {
    const sourceDirectory = resolve(request.sourceDirectory);
    const targetRoot = resolve(request.targetRoot);
    const destinationDirectory = join(targetRoot, SKILL_NAME);
    if (!existsSync(join(sourceDirectory, "SKILL.md"))) {
        throw new Error(`Bundled SupaCloud CLI skill not found: ${sourceDirectory}`);
    }
    const files = regularFiles(sourceDirectory);
    if (!existsSync(destinationDirectory)) return installNewSkill(request, files);
    if (directoriesMatch(sourceDirectory, destinationDirectory)) {
        return skillSummary(request, "none", files, null);
    }
    if (request.conflictPolicy === "reject") {
        throw new Error(`${destinationDirectory} already exists with different content; rerun with --force to back it up and replace it`);
    }
    return installReplacementSkill(request, files);
}

function installNewSkill(request: InstallSkillRequest, files: string[]): SkillInstallSummary {
    const sourceDirectory = resolve(request.sourceDirectory);
    const targetRoot = resolve(request.targetRoot);
    if (request.mode === "write") {
        createSkill(sourceDirectory, targetRoot, join(targetRoot, SKILL_NAME));
    }
    return skillSummary(request, "create", files, null);
}

function installReplacementSkill(request: InstallSkillRequest, files: string[]): SkillInstallSummary {
    const sourceDirectory = resolve(request.sourceDirectory);
    const targetRoot = resolve(request.targetRoot);
    const destinationDirectory = join(targetRoot, SKILL_NAME);
    const backupDirectory = availableBackupDirectory(destinationDirectory, request.now);
    if (request.mode === "write") {
        replaceSkill(sourceDirectory, targetRoot, destinationDirectory, backupDirectory);
    }
    return skillSummary(request, "replace", files, backupDirectory);
}

export function resolveDefaultCodexSkillRoot(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory = homedir(),
): string {
    const codexHome = environment.CODEX_HOME?.trim();
    return join(resolve(codexHome || join(homeDirectory, ".codex")), "skills");
}

/** Stable aliases for common Agent Skill roots; any other value remains an explicit path. */
export const SKILL_TARGET_ALIASES = ["codex", "claude", "agents", "project"] as const;
export type SkillTargetAlias = typeof SKILL_TARGET_ALIASES[number];

export function resolveSkillTargetRoot(
    target: string | undefined,
    options: {
        environment?: NodeJS.ProcessEnv;
        homeDirectory?: string;
        workingDirectory?: string;
    } = {},
): string {
    const environment = options.environment ?? process.env;
    const homeDirectory = options.homeDirectory ?? homedir();
    const workingDirectory = options.workingDirectory ?? process.cwd();
    const normalized = target?.trim().toLowerCase();
    if (!normalized || normalized === "codex") return resolveDefaultCodexSkillRoot(environment, homeDirectory);
    if (normalized === "claude") {
        const config = environment.CLAUDE_CONFIG_DIR?.trim();
        return join(resolve(config || join(homeDirectory, ".claude")), "skills");
    }
    if (normalized === "agents") {
        const config = environment.AGENTS_HOME?.trim();
        return join(resolve(config || join(homeDirectory, ".agents")), "skills");
    }
    if (normalized === "project") return join(resolve(workingDirectory), ".agents", "skills");
    return resolve(target!);
}

export function resolveBundledSkillDirectory(moduleUrl = import.meta.url): string {
    const moduleDirectory = dirname(fileURLToPath(moduleUrl));
    const candidates = [
        resolve(moduleDirectory, "../../../skills", SKILL_NAME),
        resolve(moduleDirectory, "../skills", SKILL_NAME),
    ];
    const skillDirectory = candidates.find((candidate) => existsSync(join(candidate, "SKILL.md")));
    if (!skillDirectory) throw new Error("Bundled SupaCloud CLI skill is missing from this installation");
    return skillDirectory;
}

function textResponse(payload: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

export function registerAiTools(server: ToolServer): void {
    registerTool(server,
        "ai",
        "Install or inspect the bundled SupaCloud CLI AI skill. Actions: show_skill, install_skill",
        {
            action: stringEnum(["show_skill", "install_skill"]),
            target: optional(Type.String(), "[install_skill] codex|claude|agents|project or an explicit Skill root directory"),
            dry_run: optional(Type.Boolean(), "[install_skill] Preview the installation without writing files"),
            force: optional(Type.Boolean(), "[install_skill] Back up and replace different existing skill content"),
        },
        async (request) => {
            const sourceDirectory = resolveBundledSkillDirectory();
            const defaultTargetRoot = resolveDefaultCodexSkillRoot();
            if (request.action === "show_skill") {
                return textResponse({
                    name: SKILL_NAME,
                    sourceDirectory,
                    defaultTargetRoot,
                    defaultDestination: join(defaultTargetRoot, SKILL_NAME),
                    targetAliases: Object.fromEntries(SKILL_TARGET_ALIASES.map((alias) => [
                        alias, resolveSkillTargetRoot(alias),
                    ])),
                });
            }
            const targetRoot = resolveSkillTargetRoot(request.target);
            return textResponse(installSkill({
                sourceDirectory,
                targetRoot,
                mode: request.dry_run ? "dry-run" : "write",
                conflictPolicy: request.force ? "replace" : "reject",
                now: new Date(),
            }));
        },
    );
}
