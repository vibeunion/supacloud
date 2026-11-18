import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ApplicationIdSchema } from "@supacloud/delivery";
import { optional, stringEnum, withDescription } from "../schema";
import type { ToolSchema } from "../schema";
import { registerTool, type ToolResult, type ToolServer } from "../tool-server";

/**
 * Read-only plan for a user-owned monorepo that builds more than one application.
 *
 * This is not `scripts/workspace` (`workspace:affected`). That runner models this
 * repository's `packages/` manifests, stays in shadow mode, and does not select
 * SupaCloud projects. Compiler `supacloud.environments.v1` binds infra resources
 * to `local` or `scheme:name`; it does not bind an application directory to a
 * project ref. Per-app `supacloud.json` stays the single-application deploy file.
 *
 * `supacloud.workspace.json` is the versioned map. Planning never runs the
 * declared build, never writes a project, and is not a deployment receipt.
 */

const execFileAsync = promisify(execFile);

export const WORKSPACE_CONFIG_FILE = "supacloud.workspace.json";
export const WORKSPACE_CONFIG_SCHEMA = "supacloud.workspace.v1";
export const WORKSPACE_PLAN_SCHEMA = "supacloud.workspace-plan.v1";

/** Platform project refs are 1–20 characters. See ApplicationDeployPlanSchema. */
const PROJECT_REF_PATTERN = /^[a-z0-9-]{1,20}$/;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
const BUILD_INTENT_PATTERN = /^[A-Za-z0-9 ._"':=,@/^~+-]+$/;
const GIT_REF_PATTERN = /^(?:HEAD|[A-Za-z0-9][A-Za-z0-9._/-]{0,127})$/;
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

export const WORKSPACE_PLAN_LIMITS = Object.freeze({
    applications: 32,
    sharedPaths: 32,
    packages: 128,
    changedFiles: 4096,
    configBytes: 256 * 1024,
    directories: 2000,
    depth: 8,
});

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype", "database_url", "db_url", "connection_string", "password", "secret", "token"]);

export class WorkspacePlanError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
        this.name = "WorkspacePlanError";
    }
}

export interface WorkspaceBinding {
    project_ref: string;
    application_id: string;
}

export interface WorkspacePlanTask {
    kind: "build" | "deploy";
    status: "planned";
    executed: false;
    command: string | null;
}

export interface WorkspacePlanApplication {
    id: string;
    root: string;
    impact: "affected" | "unaffected" | "unknown";
    reasons: string[];
    configured_binding: WorkspaceBinding | null;
    target: WorkspaceBinding | null;
    tasks: WorkspacePlanTask[];
}

export interface WorkspacePlanUnresolved {
    code: string;
    path: string | null;
    package: string | null;
    specifier: string | null;
    possible_dependents: string[];
    reason: string;
}

export interface WorkspacePlanDiagnostic {
    code: string;
    severity: "error";
    application_id: string | null;
    message: string;
}

export interface WorkspacePlan {
    schema: typeof WORKSPACE_PLAN_SCHEMA;
    status: "ready" | "unchanged" | "no-impact" | "blocked";
    executable: false;
    effects: "none";
    environment: string | null;
    config_file: typeof WORKSPACE_CONFIG_FILE;
    config_schema: typeof WORKSPACE_CONFIG_SCHEMA;
    completeness: "manifest-dependency-closure";
    deployment_verified: false;
    changed_files: string[];
    execution: {
        mode: "plan-only";
        executes_build: false;
        executes_deploy: false;
        writes_remote_state: false;
        push_webhook: "not-registered";
        deploy_time_enforcement: false;
    };
    repository: string | null;
    applications: WorkspacePlanApplication[];
    unresolved: WorkspacePlanUnresolved[];
    diagnostics: WorkspacePlanDiagnostic[];
    limits: typeof WORKSPACE_PLAN_LIMITS;
    plan_sha256: string;
}

interface ConfiguredApplication {
    id: string;
    root: string;
    build: string;
    environments: Record<string, WorkspaceBinding>;
}

interface WorkspaceConfig {
    repository: string | null;
    applications: ConfiguredApplication[];
    sharedPaths: string[];
}

interface PackageNode {
    root: string;
    name: string | null;
    applicationId: string | null;
    dependencies: Array<{ field: string; name: string; specifier: string }>;
}

interface GraphEdge {
    dependent: string;
    dependency: string;
    field: string;
    name: string;
}

interface UnresolvedEdge {
    dependent: string;
    field: string;
    name: string;
    specifier: string;
    ambiguous: boolean;
}

const configSchema = Type.Object({
    schema: Type.Literal(WORKSPACE_CONFIG_SCHEMA),
    applications: Type.Array(Type.Object({
        id: ApplicationIdSchema,
        root: Type.String({ minLength: 1, maxLength: 256 }),
        build: Type.String({ minLength: 1, maxLength: 256 }),
        environments: Type.Record(Type.String(), Type.Object({
            project_ref: Type.String(),
            application_id: ApplicationIdSchema,
        }, { additionalProperties: false })),
    }, { additionalProperties: false }), { minItems: 1, maxItems: WORKSPACE_PLAN_LIMITS.applications }),
    shared_paths: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: WORKSPACE_PLAN_LIMITS.sharedPaths }),
    repository: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
}, { additionalProperties: false });

export const workspaceToolSchema: ToolSchema = {
    action: withDescription(stringEnum(["plan", "execute", "retry", "promote", "rollback", "reconcile", "status"]), "Workspace action"),
    root: optional(Type.String(), "[plan/execute/retry/promote/rollback/reconcile/status] Repository root (default: current directory)"),
    environment: optional(Type.String(), "[plan/execute/retry/promote/rollback/reconcile/status] Required environment name. Selects that binding only"),
    base: optional(Type.String(), "[plan/execute/retry/status] Git baseline commit. Mutually exclusive with --changed"),
    head: optional(Type.String(), "[plan/execute/retry/status] Git head (default: HEAD). Requires --base"),
    changed: optional(Type.String(), "[plan/execute/retry/status] In-repo file of relative paths, one per line. Mutually exclusive with --base"),
    format: optional(stringEnum(["text", "json"]), "[*] Output format (default: text)"),
    execute: optional(Type.Boolean(), "[execute/retry/promote/rollback/reconcile] Required opt-in. Absent or false performs no build, upload, transfer, or deploy"),
    plan_sha256: optional(Type.String(), "[execute/retry/promote/rollback] Workspace plan digest that must match a fresh plan"),
    source_revision: optional(Type.String(), "[execute/retry/promote/rollback] Git commit that must match HEAD"),
    approval_id: optional(Type.String(), "[promote/rollback/execute production] Server approval id. Local files are not approval"),
    mutation_id: optional(Type.String(), "[retry/reconcile/rollback] Existing mutation or activation id. Unknown outcomes never receive a new id"),
    release_id: optional(Type.String(), "[promote/rollback] Exact immutable release. Promotion and rollback do not choose the newest release"),
    application: optional(Type.String(), "[promote/rollback/retry/execute] One application id when the plan names more than one target"),
    configuration_id: optional(Type.String(), "[rollback/promote] Immutable configuration revision"),
    activation_id: optional(Type.String(), "[rollback] Activation id. Retries reuse it"),
    expected_activation_id: optional(Type.String(), "[rollback] Current activation id, or absent"),
    source_environment: optional(Type.String(), "[promote] Environment that already has the verified release"),
};

function isNodeError(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
}

function safeSegment(segment: string): boolean {
    return /^[A-Za-z0-9._@+-]+$/.test(segment) && segment !== "." && segment !== ".."
        && segment !== "node_modules" && segment !== ".git";
}

function safeRelative(path: string): boolean {
    if (path.length === 0 || path.length > 256 || path.includes("\\") || path.includes("\0")) return false;
    const segments = path.split("/");
    return segments.length > 0 && segments.every(safeSegment);
}

function safeBuild(command: string): boolean {
    if (!BUILD_INTENT_PATTERN.test(command) || command.includes("..") || command.includes("://")) return false;
    // Bare NAME=value is an environment assignment. --flag=value stays allowed.
    if (/(?:^|[\s;&|])[A-Za-z_][A-Za-z0-9_]*=/.test(command)) return false;
    return !/token|secret|password|passwd|credential|api[_-]?key/i.test(command);
}

function inside(root: string, candidate: string): boolean {
    const path = relative(root, candidate);
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function overlaps(left: string, right: string): boolean {
    return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function globMatch(pattern: string, path: string): boolean {
    const matchFrom = (patternParts: string[], pathParts: string[], patternIndex: number, pathIndex: number): boolean => {
        if (patternIndex === patternParts.length) return pathIndex === pathParts.length;
        const token = patternParts[patternIndex] ?? "";
        if (token === "**") {
            return matchFrom(patternParts, pathParts, patternIndex + 1, pathIndex)
                || (pathIndex < pathParts.length && matchFrom(patternParts, pathParts, patternIndex, pathIndex + 1));
        }
        if (pathIndex >= pathParts.length) return false;
        if (token !== "*" && token !== pathParts[pathIndex]) return false;
        return matchFrom(patternParts, pathParts, patternIndex + 1, pathIndex + 1);
    };
    return safeRelative(path) && matchFrom(pattern.split("/"), path.split("/"), 0, 0);
}

function validGlob(pattern: string): boolean {
    const parts = pattern.split("/");
    return parts.length > 0 && parts.every(part => part === "*" || part === "**" || safeSegment(part))
        && parts.some(part => part === "*" || part === "**");
}

function compareText(left: string, right: string): number {
    return left.localeCompare(right, "en");
}

function uniqueSorted(values: readonly string[]): string[] {
    return [...new Set(values)].sort(compareText);
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort(compareText).map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

function digest(value: unknown): string {
    return createHash("sha256").update(canonical(value)).digest("hex");
}

function assertUniqueJsonKeys(text: string): void {
    const invalid = () => new WorkspacePlanError("workspace-config-invalid", "supacloud.workspace.json is not valid JSON");
    const duplicate = () => new WorkspacePlanError("duplicate-json-key", "supacloud.workspace.json contains a duplicate object key");
    let index = 0;
    const skip = () => { while (index < text.length && text[index]! <= " ") index += 1; };
    const parseString = (): string => {
        if (text[index] !== "\"") throw invalid();
        index += 1;
        let value = "";
        while (index < text.length) {
            const char = text[index]!;
            if (char === "\"") { index += 1; return value; }
            if (char === "\\") {
                index += 1;
                const escaped = text[index++];
                if (escaped === undefined) throw invalid();
                if (escaped === "u") {
                    const hex = text.slice(index, index + 4);
                    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw invalid();
                    value += String.fromCharCode(Number.parseInt(hex, 16));
                    index += 4;
                    continue;
                }
                const mapped: Record<string, string> = { "\"": "\"", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
                if (!Object.hasOwn(mapped, escaped)) throw invalid();
                value += mapped[escaped];
                continue;
            }
            if (char <= "\u001f") throw invalid();
            value += char;
            index += 1;
        }
        throw invalid();
    };
    const parseValue = (): void => {
        skip();
        const char = text[index];
        if (char === "{") { parseObject(); return; }
        if (char === "[") { parseArray(); return; }
        if (char === "\"") { parseString(); return; }
        if (text.startsWith("true", index)) { index += 4; return; }
        if (text.startsWith("false", index)) { index += 5; return; }
        if (text.startsWith("null", index)) { index += 4; return; }
        if (char === "-" || (char !== undefined && char >= "0" && char <= "9")) {
            while (index < text.length && !/[\s,\]}]/.test(text[index]!)) index += 1;
            return;
        }
        throw invalid();
    };
    const parseObject = (): void => {
        index += 1;
        const seen = new Set<string>();
        skip();
        if (text[index] === "}") { index += 1; return; }
        while (index < text.length) {
            skip();
            const key = parseString();
            if (FORBIDDEN_KEYS.has(key)) {
                throw new WorkspacePlanError("secret-rejected", "supacloud.workspace.json contains a forbidden field");
            }
            if (seen.has(key)) throw duplicate();
            seen.add(key);
            skip();
            if (text[index] !== ":") throw invalid();
            index += 1;
            parseValue();
            skip();
            if (text[index] === ",") { index += 1; continue; }
            if (text[index] === "}") { index += 1; return; }
            throw invalid();
        }
        throw invalid();
    };
    const parseArray = (): void => {
        index += 1;
        skip();
        if (text[index] === "]") { index += 1; return; }
        while (index < text.length) {
            parseValue();
            skip();
            if (text[index] === ",") { index += 1; continue; }
            if (text[index] === "]") { index += 1; return; }
            throw invalid();
        }
        throw invalid();
    };
    skip();
    parseValue();
    skip();
    if (index !== text.length) throw invalid();
}

function rejectForbiddenKeys(value: unknown): void {
    if (Array.isArray(value)) {
        for (const entry of value) rejectForbiddenKeys(entry);
        return;
    }
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value)) {
        if (FORBIDDEN_KEYS.has(key)) {
            throw new WorkspacePlanError("secret-rejected", "supacloud.workspace.json contains a forbidden field");
        }
        rejectForbiddenKeys((value as Record<string, unknown>)[key]);
    }
}

async function readRegularFile(path: string, maxBytes: number): Promise<string | null> {
    let handle;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
        if (isNodeError(error, "ENOENT")) return null;
        if (isNodeError(error, "ELOOP")) {
            throw new WorkspacePlanError("symlink-rejected", "Refusing to read a symlink");
        }
        throw error;
    }
    try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new WorkspacePlanError("workspace-path-invalid", "Expected a regular file");
        if (stat.size > maxBytes) throw new WorkspacePlanError("workspace-config-too-large", "Workspace configuration exceeds the size limit");
        return await handle.readFile({ encoding: "utf8" });
    } finally {
        await handle.close();
    }
}

async function pathKind(rootReal: string, relativePath: string): Promise<"ok" | "symlink" | "outside" | "invalid"> {
    if (!safeRelative(relativePath)) return "invalid";
    let current = rootReal;
    const segments = relativePath.split("/");
    for (let index = 0; index < segments.length; index += 1) {
        current = join(current, segments[index]!);
        try {
            const stat = await lstat(current);
            if (stat.isSymbolicLink()) return "symlink";
        } catch (error) {
            if (!isNodeError(error, "ENOENT")) throw error;
            const parent = index === 0 ? rootReal : join(rootReal, segments.slice(0, index).join("/"));
            const realParent = await realpath(parent).catch(() => null);
            return realParent && inside(rootReal, realParent) ? "ok" : "outside";
        }
    }
    const real = await realpath(current).catch(() => null);
    return real && inside(rootReal, real) ? "ok" : "outside";
}

async function listDirectories(rootReal: string): Promise<{ directories: string[]; truncated: boolean }> {
    const directories: string[] = [];
    const queue = [""];
    while (queue.length > 0) {
        const current = queue.shift() ?? "";
        if (current.split("/").filter(Boolean).length >= WORKSPACE_PLAN_LIMITS.depth) continue;
        const entries = await readdir(join(rootReal, current), { withFileTypes: true });
        entries.sort((left, right) => compareText(left.name, right.name));
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.isSymbolicLink() || !safeSegment(entry.name)) continue;
            const child = current ? `${current}/${entry.name}` : entry.name;
            directories.push(child);
            if (directories.length > WORKSPACE_PLAN_LIMITS.directories) return { directories, truncated: true };
            queue.push(child);
        }
    }
    return { directories, truncated: false };
}

function sharedRootFor(file: string, patterns: readonly string[], directories: readonly string[]): string | null {
    const parts = file.split("/");
    let match: string | null = null;
    for (let length = 1; length < parts.length; length += 1) {
        const directory = parts.slice(0, length).join("/");
        if (!patterns.some(pattern => globMatch(pattern, directory))) continue;
        if (directories.includes(directory) || directories.some(entry => entry.startsWith(`${directory}/`))) {
            match = directory;
        } else if (match === null) match = directory;
    }
    return match;
}

function parseChangedList(text: string): string[] {
    const files: string[] = [];
    for (const line of text.split("\n")) {
        const path = line.endsWith("\r") ? line.slice(0, -1).trim() : line.trim();
        if (path.length === 0) continue;
        if (!safeRelative(path)) {
            throw new WorkspacePlanError("invalid-changed-path", "A changed path is absolute, traverses parents, or is otherwise unsafe");
        }
        files.push(path);
    }
    if (files.length > WORKSPACE_PLAN_LIMITS.changedFiles) {
        throw new WorkspacePlanError("changed-files-limit", "Too many changed paths");
    }
    return uniqueSorted(files);
}

function validGitRef(ref: string): boolean {
    return GIT_REF_PATTERN.test(ref) && !ref.includes("..") && !ref.includes("//") && !ref.endsWith("/");
}

async function git(cwd: string, args: string[]): Promise<string> {
    const env: Record<string, string> = { GIT_OPTIONAL_LOCKS: "0" };
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) env[key] = value;
    }
    env.GIT_OPTIONAL_LOCKS = "0";
    // core.fsmonitor can be a repository-configured command. Name-only diffs must not run it or refresh its state.
    const { stdout } = await execFileAsync("git", ["-c", "core.fsmonitor=", "-c", "core.fsmonitorHookVersion=0", ...args], {
        cwd, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 10_000, shell: false, windowsHide: true, env,
    });
    return stdout;
}

/** Checked-out commit. This does not accept a caller-supplied revision as its own proof. */
export async function readWorkspaceHead(root: string): Promise<string> {
    return (await git(root, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])).trim();
}

/** Read a changed-path list only when it is a regular file inside the workspace. */
export async function readWorkspaceChangedList(root: string, changed: string): Promise<string[]> {
    const rootReal = await realpath(resolve(root));
    const listRelative = relative(rootReal, resolve(rootReal, changed)).replaceAll("\\", "/");
    if (!safeRelative(listRelative) || await pathKind(rootReal, listRelative) !== "ok") {
        throw new WorkspacePlanError("invalid-changed-path", "The changed-file list must be a regular file inside the workspace");
    }
    const text = await readRegularFile(join(rootReal, listRelative), WORKSPACE_PLAN_LIMITS.configBytes);
    if (text === null) throw new WorkspacePlanError("invalid-changed-path", "The changed-file list was not found");
    return parseChangedList(text);
}

/** Same rename/delete input rule as scripts/workspace: both sides are visible, and a missing baseline is explicit. */
export async function collectGitChanges(root: string, base: string, head = "HEAD"): Promise<{ files: string[]; fallback: string | null }> {
    if (!validGitRef(base) || !validGitRef(head)) {
        return { files: [], fallback: "Git baseline/history could not be resolved; no project was selected." };
    }
    const split = (value: string) => value.split("\0").filter(Boolean);
    try {
        const commit = async (ref: string) => (await git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
        const headSha = await commit(head);
        if (headSha !== await commit("HEAD")) {
            return { files: [], fallback: "Requested head does not match the checked-out tree; no project was selected." };
        }
        const baseSha = await commit(base);
        const files = split(await git(root, ["diff", "--no-renames", "--name-only", "-z", baseSha, headSha, "--"]));
        files.push(...split(await git(root, ["diff", "--no-renames", "--name-only", "-z", "HEAD", "--"])));
        files.push(...split(await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])));
        return { files: parseChangedList(`${uniqueSorted(files).join("\n")}\n`), fallback: null };
    } catch {
        return { files: [], fallback: "Git baseline/history could not be resolved; no project was selected." };
    }
}

function parseConfigText(text: string): WorkspaceConfig {
    const source = text.replace(/^\uFEFF/, "");
    assertUniqueJsonKeys(source);
    let parsed: unknown;
    try { parsed = JSON.parse(source) as unknown; }
    catch { throw new WorkspacePlanError("workspace-config-invalid", "supacloud.workspace.json is not valid JSON"); }
    rejectForbiddenKeys(parsed);
    if (!Value.Check(configSchema, parsed)) {
        throw new WorkspacePlanError("workspace-config-invalid", "supacloud.workspace.json does not match supacloud.workspace.v1");
    }
    const applications: ConfiguredApplication[] = [];
    const seenIds = new Set<string>();
    const seenRoots = new Set<string>();
    const seenTargets = new Set<string>();
    for (const application of parsed.applications) {
        if (!safeRelative(application.root) || !safeBuild(application.build)) {
            throw new WorkspacePlanError("invalid-path", "An application root or build intent is unsafe");
        }
        if (seenIds.has(application.id)) throw new WorkspacePlanError("duplicate-application-id", "Application ids must be unique");
        if ([...seenRoots].some(root => overlaps(root, application.root))) {
            throw new WorkspacePlanError("overlapping-application-root", "Application roots overlap");
        }
        seenIds.add(application.id);
        seenRoots.add(application.root);
        const environments: Record<string, WorkspaceBinding> = Object.create(null) as Record<string, WorkspaceBinding>;
        for (const [name, binding] of Object.entries(application.environments).sort(([left], [right]) => compareText(left, right))) {
            if (!Value.Check(ApplicationIdSchema, name) || !PROJECT_REF_PATTERN.test(binding.project_ref)) {
                throw new WorkspacePlanError("invalid-binding", "An environment binding is not a platform environment id or project ref");
            }
            if (binding.application_id !== application.id) {
                throw new WorkspacePlanError("application-binding-mismatch", `Application '${application.id}' must bind to the same application id`);
            }
            const targetKey = `${name}\0${binding.project_ref}\0${binding.application_id}`;
            if (seenTargets.has(targetKey)) {
                throw new WorkspacePlanError("ambiguous-target", "Two applications bind one environment to the same project and application");
            }
            seenTargets.add(targetKey);
            environments[name] = { project_ref: binding.project_ref, application_id: binding.application_id };
        }
        applications.push({ id: application.id, root: application.root, build: application.build, environments });
    }
    const sharedPaths: string[] = [];
    for (const pattern of parsed.shared_paths) {
        if (!validGlob(pattern)) throw new WorkspacePlanError("invalid-path", "A shared path is absolute, traverses parents, or is not a relative glob");
        sharedPaths.push(pattern);
    }
    const repository = typeof parsed.repository === "string" ? parsed.repository : null;
    if (repository !== null && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(repository)) {
        throw new WorkspacePlanError("invalid-repository", "repository must be a credential-free source identity without a user, scheme, or URL");
    }
    return {
        repository,
        applications: applications.sort((left, right) => compareText(left.id, right.id)),
        sharedPaths: uniqueSorted(sharedPaths),
    };
}

async function readPackageManifest(rootReal: string, packageRoot: string): Promise<{ name: string | null; dependencies: PackageNode["dependencies"] } | null> {
    const manifestPath = join(rootReal, packageRoot, "package.json");
    const text = await readRegularFile(manifestPath, WORKSPACE_PLAN_LIMITS.configBytes);
    if (text === null) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(text.replace(/^\uFEFF/, "")) as unknown; }
    catch { throw new WorkspacePlanError("package-manifest-invalid", `package.json is not valid JSON at ${packageRoot}`); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new WorkspacePlanError("package-manifest-invalid", `package.json is not an object at ${packageRoot}`);
    }
    const record = parsed as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : null;
    if (name !== null && !PACKAGE_NAME_PATTERN.test(name)) {
        throw new WorkspacePlanError("package-manifest-invalid", `package.json name is invalid at ${packageRoot}`);
    }
    const dependencies: PackageNode["dependencies"] = [];
    for (const field of DEPENDENCY_FIELDS) {
        const value = record[field];
        if (value === undefined) continue;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new WorkspacePlanError("package-manifest-invalid", `package.json ${field} is invalid at ${packageRoot}`);
        }
        for (const [dependencyName, specifier] of Object.entries(value).sort(([left], [right]) => compareText(left, right))) {
            if (!PACKAGE_NAME_PATTERN.test(dependencyName) || typeof specifier !== "string" || specifier.length > 256 || specifier.includes("\0")) {
                throw new WorkspacePlanError("package-manifest-invalid", `package.json dependency is invalid at ${packageRoot}`);
            }
            if (/^[a-z][a-z0-9+.-]*:\/\//i.test(specifier)) {
                throw new WorkspacePlanError("secret-rejected", "A package dependency specifier must not be a URL");
            }
            dependencies.push({ field, name: dependencyName, specifier });
        }
    }
    return { name, dependencies };
}

function resolveLocalSpecifier(fromRoot: string, specifier: string): { kind: "name" } | { kind: "path"; path: string } | { kind: "ambiguous" } | null {
    const workspace = specifier.startsWith("workspace:") ? specifier.slice("workspace:".length) : null;
    const relativeSpecifier = workspace ?? specifier;
    if (workspace !== null && (workspace === "*" || workspace.startsWith("^") || workspace.startsWith("~") || /^[0-9]/.test(workspace))) {
        return { kind: "name" };
    }
    if (relativeSpecifier.startsWith("file:") || relativeSpecifier.startsWith("link:") || relativeSpecifier.startsWith(".") || workspace !== null) {
        const raw = relativeSpecifier.replace(/^(file:|link:)/, "");
        if (!raw.startsWith(".")) return { kind: "ambiguous" };
        const normalized = join(fromRoot, raw).replaceAll("\\", "/").replace(/\/+$/, "");
        if (!safeRelative(normalized)) return { kind: "ambiguous" };
        return { kind: "path", path: normalized };
    }
    return null;
}

async function loadGraph(rootReal: string, config: WorkspaceConfig): Promise<{ nodes: PackageNode[]; edges: GraphEdge[]; unresolved: UnresolvedEdge[]; diagnostics: WorkspacePlanDiagnostic[] }> {
    const diagnostics: WorkspacePlanDiagnostic[] = [];
    const { directories, truncated } = await listDirectories(rootReal);
    if (truncated) diagnostics.push({ code: "shared-path-limit", severity: "error", application_id: null, message: "Shared path discovery exceeded the directory limit" });
    const sharedDirectories = directories.filter(directory => config.sharedPaths.some(pattern => globMatch(pattern, directory)));
    for (const application of config.applications) {
        const kind = await pathKind(rootReal, application.root);
        if (kind !== "ok") diagnostics.push({ code: kind === "symlink" ? "symlink-rejected" : "invalid-path", severity: "error", application_id: application.id, message: `Application root '${application.root}' is not a contained directory` });
        else {
            const stat = await lstat(join(rootReal, application.root)).catch(() => null);
            if (!stat?.isDirectory()) diagnostics.push({ code: "application-root-missing", severity: "error", application_id: application.id, message: `Application root '${application.root}' is not a directory` });
        }
        if (sharedDirectories.some(directory => overlaps(directory, application.root))) {
            diagnostics.push({ code: "shared-path-overlap", severity: "error", application_id: application.id, message: `Application root '${application.root}' overlaps a shared path` });
        }
    }
    const packageRoots = uniqueSorted([
        ...config.applications.map(application => application.root),
        ...sharedDirectories.filter(directory => !config.applications.some(application => overlaps(application.root, directory))),
    ]);
    if (packageRoots.length > WORKSPACE_PLAN_LIMITS.packages) {
        diagnostics.push({ code: "package-limit", severity: "error", application_id: null, message: "Too many workspace packages" });
    }
    const nodes: PackageNode[] = [];
    for (const packageRoot of packageRoots) {
        if ((await pathKind(rootReal, packageRoot)) !== "ok") {
            diagnostics.push({ code: "symlink-rejected", severity: "error", application_id: null, message: `Package root '${packageRoot}' is not contained` });
            continue;
        }
        const manifest = await readPackageManifest(rootReal, packageRoot).catch((error: unknown) => {
            if (error instanceof WorkspacePlanError) {
                diagnostics.push({ code: error.code, severity: "error", application_id: null, message: error.message });
                return null;
            }
            throw error;
        });
        const application = config.applications.find(entry => entry.root === packageRoot) ?? null;
        nodes.push({
            root: packageRoot,
            name: manifest?.name ?? null,
            applicationId: application?.id ?? null,
            dependencies: manifest?.dependencies ?? [],
        });
    }
    const byRoot = new Map(nodes.map(node => [node.root, node]));
    const byName = new Map<string, PackageNode[]>();
    for (const node of nodes) {
        if (!node.name) continue;
        byName.set(node.name, [...(byName.get(node.name) ?? []), node]);
    }
    for (const [name, matches] of byName) {
        if (matches.length > 1) diagnostics.push({ code: "duplicate-package-name", severity: "error", application_id: null, message: `Package name '${name}' is declared more than once` });
    }
    const edges: GraphEdge[] = [];
    const unresolved: UnresolvedEdge[] = [];
    for (const node of nodes) {
        for (const dependency of node.dependencies) {
            const local = resolveLocalSpecifier(node.root, dependency.specifier);
            let target: PackageNode | undefined;
            let ambiguous = false;
            if (local?.kind === "path") target = byRoot.get(local.path);
            else if (local?.kind === "name" || local === null) {
                const matches = byName.get(dependency.name) ?? [];
                if (matches.length === 1) target = matches[0];
            } else ambiguous = true;
            if (local && !target) {
                unresolved.push({ dependent: node.root, field: dependency.field, name: dependency.name, specifier: dependency.specifier, ambiguous: ambiguous || local.kind !== "name" });
                continue;
            }
            if (!target || target.root === node.root) {
                if (target?.root === node.root) diagnostics.push({ code: "self-dependency", severity: "error", application_id: node.applicationId, message: `Package '${node.root}' depends on itself` });
                continue;
            }
            if (target.name && target.name !== dependency.name && local?.kind === "path") {
                unresolved.push({ dependent: node.root, field: dependency.field, name: dependency.name, specifier: dependency.specifier, ambiguous: true });
                continue;
            }
            edges.push({ dependent: node.root, dependency: target.root, field: dependency.field, name: dependency.name });
        }
    }
    return { nodes, edges, unresolved, diagnostics };
}

async function readApplicationConfig(rootReal: string, application: ConfiguredApplication, environment: string): Promise<WorkspacePlanDiagnostic[]> {
    const relativePath = `${application.root}/supacloud.json`;
    const kind = await pathKind(rootReal, relativePath);
    if (kind !== "ok") {
        return [{
            code: kind === "symlink" ? "symlink-rejected" : "invalid-path", severity: "error", application_id: application.id,
            message: `supacloud.json for '${application.root}' is not a regular file inside the workspace`,
        }];
    }
    const path = join(rootReal, relativePath);
    const text = await readRegularFile(path, WORKSPACE_PLAN_LIMITS.configBytes);
    if (text === null) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(text.replace(/^\uFEFF/, "")) as unknown; }
    catch { return [{ code: "supacloud-json-invalid", severity: "error", application_id: application.id, message: `supacloud.json at ${application.root} is not valid JSON` }]; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Object.hasOwn(parsed, "application")) return [];
    const record = (parsed as { application?: unknown }).application;
    if (!record || typeof record !== "object" || Array.isArray(record)) {
        return [{ code: "supacloud-json-application-mismatch", severity: "error", application_id: application.id, message: `supacloud.json application at ${application.root} must be an object` }];
    }
    const id = (record as { id?: unknown }).id;
    const environmentId = (record as { environmentId?: unknown }).environmentId;
    const diagnostics: WorkspacePlanDiagnostic[] = [];
    if (id !== undefined && id !== application.id) {
        diagnostics.push({ code: "supacloud-json-application-mismatch", severity: "error", application_id: application.id, message: `supacloud.json application.id at ${application.root} does not match '${application.id}'` });
    }
    if (environmentId !== undefined && environmentId !== environment) {
        diagnostics.push({ code: "supacloud-json-environment-differs", severity: "error", application_id: application.id, message: `supacloud.json application.environmentId at ${application.root} does not match the selected environment` });
    }
    return diagnostics;
}

function ownerRoot(file: string, applications: readonly ConfiguredApplication[]): string | null {
    return applications.map(application => application.root).filter(root => file === root || file.startsWith(`${root}/`))
        .sort((left, right) => right.length - left.length)[0] ?? null;
}

function finishPlan(plan: Omit<WorkspacePlan, "plan_sha256">): WorkspacePlan {
    const withHash = { ...plan, plan_sha256: "" };
    withHash.plan_sha256 = digest({ ...plan });
    return withHash;
}

function emptyExecution(): WorkspacePlan["execution"] {
    return {
        mode: "plan-only", executes_build: false, executes_deploy: false, writes_remote_state: false,
        push_webhook: "not-registered", deploy_time_enforcement: false,
    };
}

function blockedPlan(environment: string | null, code: string, message: string, changedFiles: string[] = []): WorkspacePlan {
    return finishPlan({
        schema: WORKSPACE_PLAN_SCHEMA, status: "blocked", executable: false, effects: "none", environment,
        config_file: WORKSPACE_CONFIG_FILE, config_schema: WORKSPACE_CONFIG_SCHEMA,
        completeness: "manifest-dependency-closure", deployment_verified: false, changed_files: changedFiles,
        execution: emptyExecution(), repository: null, applications: [], unresolved: [],
        diagnostics: [{ code, severity: "error", application_id: null, message }],
        limits: WORKSPACE_PLAN_LIMITS,
    });
}

export async function createWorkspacePlan(input: {
    root: string;
    environment: string;
    changedFiles: readonly string[];
    fallbackReason?: string | null;
}): Promise<WorkspacePlan> {
    const environment = Value.Check(ApplicationIdSchema, input.environment) ? input.environment : null;
    if (!environment) return blockedPlan(null, "invalid-environment", "The selected environment is not a valid application environment id");
    let rootReal: string;
    try { rootReal = await realpath(resolve(input.root)); }
    catch { return blockedPlan(environment, "workspace-root-missing", "The workspace root does not exist"); }
    const rootStat = await lstat(rootReal).catch(() => null);
    if (!rootStat?.isDirectory()) return blockedPlan(environment, "workspace-root-missing", "The workspace root is not a directory");
    let changedFiles: string[];
    try { changedFiles = parseChangedList(`${input.changedFiles.join("\n")}\n`); }
    catch (error) {
        if (error instanceof WorkspacePlanError) return blockedPlan(environment, error.code, error.message);
        throw error;
    }
    const configText = await readRegularFile(join(rootReal, WORKSPACE_CONFIG_FILE), WORKSPACE_PLAN_LIMITS.configBytes).catch((error: unknown) => error);
    if (configText instanceof WorkspacePlanError) return blockedPlan(environment, configText.code, configText.message, changedFiles);
    if (configText === null) return blockedPlan(environment, "workspace-config-missing", "supacloud.workspace.json was not found", changedFiles);
    if (typeof configText !== "string") throw configText;
    let config: WorkspaceConfig;
    try { config = parseConfigText(configText); }
    catch (error) {
        if (error instanceof WorkspacePlanError) return blockedPlan(environment, error.code, error.message, changedFiles);
        throw error;
    }
    const loaded = await loadGraph(rootReal, config);
    const diagnostics = [...loaded.diagnostics];
    for (const application of config.applications) diagnostics.push(...await readApplicationConfig(rootReal, application, environment));
    const { directories } = await listDirectories(rootReal);
    const applicationIds = config.applications.map(application => application.id);
    const impact = new Map<string, { impact: WorkspacePlanApplication["impact"]; reasons: string[] }>();
    for (const application of config.applications) impact.set(application.id, { impact: "unaffected", reasons: [] });
    const unresolved: WorkspacePlanUnresolved[] = [];
    const mark = (id: string, kind: WorkspacePlanApplication["impact"], reason: string) => {
        const current = impact.get(id);
        if (!current) return;
        if (kind === "unknown" || current.impact === "unaffected") current.impact = kind;
        if (!current.reasons.includes(reason)) current.reasons.push(reason);
    };
    if (input.fallbackReason) {
        unresolved.push({
            code: "git-baseline-unresolved", path: null, package: null, specifier: null,
            possible_dependents: applicationIds, reason: input.fallbackReason,
        });
        for (const id of applicationIds) mark(id, "unknown", input.fallbackReason);
        diagnostics.push({ code: "git-baseline-unresolved", severity: "error", application_id: null, message: input.fallbackReason });
    }
    const dependents = new Map<string, GraphEdge[]>();
    for (const edge of loaded.edges) dependents.set(edge.dependency, [...(dependents.get(edge.dependency) ?? []), edge]);
    const applicationByRoot = new Map(config.applications.map(application => [application.root, application]));
    const expand = (packageRoot: string, reason: string, kind: WorkspacePlanApplication["impact"]) => {
        const seen = new Set<string>();
        const queue = [packageRoot];
        while (queue.length > 0) {
            const current = queue.shift() ?? "";
            if (seen.has(current)) continue;
            seen.add(current);
            const application = applicationByRoot.get(current);
            if (application) mark(application.id, kind, reason);
            for (const edge of dependents.get(current) ?? []) queue.push(edge.dependent);
        }
    };
    for (const edge of loaded.unresolved) {
        const owner = applicationByRoot.get(edge.dependent);
        const reason = `Unresolved local dependency ${edge.name} (${edge.specifier}) from ${edge.dependent}`;
        unresolved.push({
            code: "unresolved-dependency", path: edge.dependent, package: edge.name, specifier: edge.specifier,
            possible_dependents: owner ? [owner.id] : applicationIds, reason,
        });
        diagnostics.push({ code: "unresolved-dependency", severity: "error", application_id: owner?.id ?? null, message: reason });
        if (owner) mark(owner.id, "unknown", reason);
        else expand(edge.dependent, reason, "unknown");
    }
    for (const file of changedFiles) {
        const kind = await pathKind(rootReal, file);
        if (kind === "symlink" || kind === "outside" || kind === "invalid") {
            const code = kind === "symlink" ? "symlink-rejected" : "invalid-changed-path";
            const reason = kind === "symlink"
                ? `Changed path '${file}' is a symlink and was not followed`
                : `Changed path '${file}' is outside the workspace or unsafe`;
            unresolved.push({ code, path: file, package: null, specifier: null, possible_dependents: applicationIds, reason });
            diagnostics.push({ code, severity: "error", application_id: null, message: reason });
            continue;
        }
        if (file === WORKSPACE_CONFIG_FILE) {
            for (const id of applicationIds) mark(id, "affected", "Workspace configuration changed");
            continue;
        }
        const closeDependents = (start: string) => {
            const seen = new Set<string>();
            const queue: Array<{ root: string; chain: string }> = [{ root: start, chain: start }];
            while (queue.length > 0) {
                const current = queue.shift();
                if (!current || seen.has(current.root)) continue;
                seen.add(current.root);
                const application = applicationByRoot.get(current.root);
                if (application && current.root === start) mark(application.id, "affected", `Changed input: ${file}`);
                for (const edge of dependents.get(current.root) ?? []) {
                    const chain = `${current.chain} -> ${edge.dependent} (${edge.field} ${edge.name})`;
                    const nextApplication = applicationByRoot.get(edge.dependent);
                    if (nextApplication) mark(nextApplication.id, "affected", `Changed input ${file} reaches ${nextApplication.id} through ${chain}`);
                    queue.push({ root: edge.dependent, chain });
                }
            }
        };
        const applicationRoot = ownerRoot(file, config.applications);
        if (applicationRoot) {
            closeDependents(applicationRoot);
            continue;
        }
        const shared = sharedRootFor(file, config.sharedPaths, directories);
        if (!shared) {
            const reason = `Path '${file}' is outside every application root and shared package; dependents were not inferred`;
            unresolved.push({ code: "unowned-input", path: file, package: null, specifier: null, possible_dependents: applicationIds, reason });
            diagnostics.push({ code: "unowned-input", severity: "error", application_id: null, message: reason });
            continue;
        }
        const node = loaded.nodes.find(entry => entry.root === shared);
        if (!node?.name && !applicationByRoot.has(shared)) {
            const reason = `Shared path '${shared}' has no package.json, so dependents of '${file}' cannot be resolved`;
            unresolved.push({ code: "unresolved-shared-input", path: file, package: shared, specifier: null, possible_dependents: applicationIds, reason });
            diagnostics.push({ code: "unresolved-shared-input", severity: "error", application_id: null, message: reason });
            for (const id of applicationIds) mark(id, "unknown", reason);
            continue;
        }
        closeDependents(shared);
        for (const edge of loaded.unresolved) {
            if (!edge.ambiguous && edge.name !== node?.name) continue;
            const owner = applicationByRoot.get(edge.dependent);
            const reason = `Unresolved dependency from ${edge.dependent} may include changed package '${shared}'`;
            if (owner) mark(owner.id, "unknown", reason);
            else expand(edge.dependent, reason, "unknown");
        }
    }
    const errors = diagnostics.filter(diagnostic => diagnostic.severity === "error");
    const unknown = [...impact.values()].some(entry => entry.impact === "unknown") || unresolved.length > 0 || errors.length > 0;
    const affected = [...impact.values()].some(entry => entry.impact === "affected");
    const status: WorkspacePlan["status"] = unknown ? "blocked"
        : affected ? "ready"
            : changedFiles.length === 0 && !input.fallbackReason ? "unchanged" : "no-impact";
    const applications: WorkspacePlanApplication[] = config.applications.map(application => {
        const state = impact.get(application.id) ?? { impact: "unknown" as const, reasons: ["Impact was not computed"] };
        const binding = application.environments[environment] ?? null;
        if (!binding) {
            diagnostics.push({
                code: "missing-environment-binding", severity: "error", application_id: application.id,
                message: `Application '${application.id}' has no binding for the selected environment`,
            });
        }
        const selected = status === "ready" && state.impact === "affected" && binding ? binding : null;
        return {
            id: application.id,
            root: application.root,
            impact: state.impact,
            reasons: state.reasons.sort(compareText),
            configured_binding: binding,
            target: selected,
            tasks: selected ? [
                { kind: "build", status: "planned", executed: false, command: application.build },
                { kind: "deploy", status: "planned", executed: false, command: null },
            ] : [],
        };
    });
    if (applications.some(application => application.configured_binding === null)) {
        return finishPlan({
            schema: WORKSPACE_PLAN_SCHEMA, status: "blocked", executable: false, effects: "none", environment,
            config_file: WORKSPACE_CONFIG_FILE, config_schema: WORKSPACE_CONFIG_SCHEMA,
            completeness: "manifest-dependency-closure", deployment_verified: false, changed_files: changedFiles,
            execution: emptyExecution(), repository: config.repository,
            applications: applications.map(application => ({ ...application, target: null, tasks: [] })),
            unresolved: unresolved.sort((left, right) => compareText(`${left.code}${left.path}${left.package}`, `${right.code}${right.path}${right.package}`)),
            diagnostics: diagnostics.sort((left, right) => compareText(`${left.code}${left.application_id ?? ""}${left.message}`, `${right.code}${right.application_id ?? ""}${right.message}`)),
            limits: WORKSPACE_PLAN_LIMITS,
        });
    }
    return finishPlan({
        schema: WORKSPACE_PLAN_SCHEMA, status, executable: false, effects: "none", environment,
        config_file: WORKSPACE_CONFIG_FILE, config_schema: WORKSPACE_CONFIG_SCHEMA,
        completeness: "manifest-dependency-closure", deployment_verified: false, changed_files: changedFiles,
        execution: emptyExecution(), repository: config.repository, applications,
        unresolved: unresolved.sort((left, right) => compareText(`${left.code}${left.path ?? ""}${left.package ?? ""}`, `${right.code}${right.path ?? ""}${right.package ?? ""}`)),
        diagnostics: diagnostics.sort((left, right) => compareText(`${left.code}${left.application_id ?? ""}${left.message}`, `${right.code}${right.application_id ?? ""}${right.message}`)),
        limits: WORKSPACE_PLAN_LIMITS,
    });
}

export function formatWorkspacePlan(plan: WorkspacePlan): string {
    const lines = [
        `Workspace plan ${plan.schema}`,
        `status: ${plan.status}`,
        `environment: ${plan.environment ?? "(invalid)"}`,
        "effects: none",
        "executable: false",
        "deploy-time enforcement: false",
        "push/webhook: not registered",
    ];
    if (plan.changed_files.length === 0) lines.push("changed files: (none)");
    for (const file of plan.changed_files) lines.push(`changed: ${file}`);
    for (const application of plan.applications) {
        const target = application.target
            ? `target=${application.target.project_ref} application=${application.target.application_id}`
            : "target=(none)";
        lines.push(`${application.id}  ${application.impact}  ${target}`);
        for (const reason of application.reasons) lines.push(`  why: ${reason}`);
        if (application.tasks.length === 0) lines.push("  tasks: (none)");
        for (const task of application.tasks) {
            lines.push(`  task ${task.kind} ${task.status} executed=false${task.command ? ` intent=${task.command}` : ""}`);
        }
    }
    for (const item of plan.unresolved) lines.push(`unresolved ${item.code}: ${item.reason}`);
    for (const diagnostic of plan.diagnostics) lines.push(`error ${diagnostic.code}: ${diagnostic.message}`);
    lines.push(`plan: ${plan.plan_sha256}`);
    return lines.join("\n");
}

function textResult(text: string, isError = false): ToolResult {
    return { isError, content: [{ type: "text", text }] };
}

export async function runWorkspacePlan(args: Record<string, unknown>, cwd = process.cwd()): Promise<ToolResult> {
    const format = args.format === "json" ? "json" : "text";
    const render = (plan: WorkspacePlan) => format === "json"
        ? textResult(JSON.stringify(plan, null, 2), plan.status === "blocked")
        : textResult(formatWorkspacePlan(plan), plan.status === "blocked");
    if (typeof args.environment !== "string" || args.environment.length === 0) {
        return textResult("workspace plan requires --environment", true);
    }
    const hasBase = typeof args.base === "string";
    const hasChanged = typeof args.changed === "string";
    if (hasBase === hasChanged) return textResult("workspace plan requires exactly one of --base or --changed", true);
    if (typeof args.head === "string" && !hasBase) return textResult("workspace plan --head requires --base", true);
    const root = resolve(typeof args.root === "string" ? args.root : cwd);
    try {
        if (hasChanged) {
            const rootReal = await realpath(root);
            const listRelative = relative(rootReal, resolve(rootReal, args.changed as string)).replaceAll("\\", "/");
            const environment = Value.Check(ApplicationIdSchema, args.environment) ? args.environment : null;
            if (!safeRelative(listRelative) || await pathKind(rootReal, listRelative) !== "ok") {
                return render(blockedPlan(environment, "invalid-changed-path", "The changed-file list must be a regular file inside the workspace"));
            }
            const text = await readRegularFile(join(rootReal, listRelative), WORKSPACE_PLAN_LIMITS.configBytes);
            if (text === null) return render(blockedPlan(environment, "invalid-changed-path", "The changed-file list was not found"));
            const files = parseChangedList(text);
            return render(await createWorkspacePlan({ root, environment: args.environment, changedFiles: files }));
        }
        const collected = await collectGitChanges(root, args.base as string, typeof args.head === "string" ? args.head : "HEAD");
        return render(await createWorkspacePlan({
            root, environment: args.environment, changedFiles: collected.files, fallbackReason: collected.fallback,
        }));
    } catch (error) {
        if (error instanceof WorkspacePlanError) {
            return render(blockedPlan(Value.Check(ApplicationIdSchema, args.environment) ? args.environment : null, error.code, error.message));
        }
        throw error;
    }
}

export function registerWorkspaceTools(server: ToolServer, options: { cwd?: string; getHttp?: () => import("../transports/http").HttpTransport | null } = {}): void {
    registerTool(
        server,
        "workspace",
        "Plan or explicitly execute monorepo delivery. Plan never builds or deploys. Execute, promote, and rollback require --execute and server authorization.",
        workspaceToolSchema,
        async args => {
            if (args.action === "plan") return runWorkspacePlan(args as Record<string, unknown>, options.cwd ?? process.cwd());
            const { runWorkspaceCommand } = await import("./workspace-execute");
            const { createHttpWorkspaceDeliveryClient, workspaceHttpFromTransport } = await import("./workspace-delivery-http");
            const http = options.getHttp?.() ?? null;
            const client = http ? createHttpWorkspaceDeliveryClient(workspaceHttpFromTransport(http), async (input) => {
                const { buildDeliveryProject, compileOptionsFromConfig, loadSupacloudConfig } = await import("@supacloud/compiler");
                const root = join(input.workspaceRoot, input.root);
                const loaded = await loadSupacloudConfig(root);
                const result = await buildDeliveryProject(compileOptionsFromConfig(loaded, root), loaded.delivery);
                if (!result.ok || !result.manifest) throw new Error("Workspace application build failed");
                const { canonical, digest } = await import("@supacloud/delivery/files");
                const output = typeof loaded.delivery === "object" && loaded.delivery && "outDir" in loaded.delivery && typeof loaded.delivery.outDir === "string"
                    ? loaded.delivery.outDir : "generated/delivery";
                return { manifestSha256: digest(canonical(result.manifest)), manifestPath: join(root, output, "delivery.manifest.json") };
            }) : undefined;
            return runWorkspaceCommand(args as Record<string, unknown>, options.cwd ?? process.cwd(), client);
        },
    );
}
