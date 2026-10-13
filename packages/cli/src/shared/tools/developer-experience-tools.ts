import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ApplicationIdSchema } from "@supacloud/delivery";
import { resolveSupaCloudContext, type ContextCredentialScope, type ResolvedContext } from "../context";
import { optional, stringEnum, withDescription } from "../schema";
import type { ToolSchema } from "../schema";
import { registerTool, type ToolResult, type ToolServer } from "../tool-server";

interface InitRequest {
    root?: string;
    json?: boolean;
}

interface EnvironmentRequest {
    action: "list" | "check";
    root?: string;
    json?: boolean;
}

export interface DeveloperExperienceOptions {
    cwd?: string;
    activeContext?: ResolvedContext;
}

interface PackageManifest {
    scripts?: Record<string, unknown>;
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
}

interface EnvironmentProfile {
    name: string;
    path: string;
    exists: true;
}

interface EnvironmentReport {
    name: string;
    path: string;
    environment: string | null;
    production: boolean;
    source: "named_env_file" | "invalid";
    credentialScope: ContextCredentialScope;
    projectRef: string | null;
    statusReady: boolean;
    statusMissing: string[];
    deployReady: boolean;
    deployMissing: string[];
    hasApiToken: boolean;
    hasServiceRoleKey: boolean;
    error: string | null;
}

export const initToolSchema: ToolSchema = {
    root: optional(Type.String(), "Project directory to initialize (default: current directory)"),
    json: optional(Type.Boolean(), "Emit one machine-readable JSON result"),
};

export const environmentToolSchema: ToolSchema = {
    action: withDescription(stringEnum(["list", "check"]), "Environment profile inspection action"),
    root: optional(Type.String(), "Project directory containing .env.supacloud.* files"),
    json: optional(Type.Boolean(), "Emit one machine-readable JSON result"),
};

const TEST_PROFILE = [
    "SUPACLOUD_ENV=test",
    "SUPACLOUD_API_URL=https://management.test.example.com",
    "SUPACLOUD_API_TOKEN=<test-management-api-token>",
    "SUPACLOUD_PROJECT_REF=<test-project-ref>",
    "SUPACLOUD_APPLICATION_ID=<application-id>",
    "",
].join("\n");

const PRODUCTION_PROFILE = [
    "SUPACLOUD_ENV=production",
    "SUPACLOUD_API_URL=https://management.example.com",
    "SUPACLOUD_API_TOKEN=<production-management-api-token>",
    "SUPACLOUD_PROJECT_REF=<production-project-ref>",
    "SUPACLOUD_APPLICATION_ID=<application-id>",
    "",
].join("\n");

function textResult(text: string, isError = false): ToolResult {
    return { isError, content: [{ type: "text", text }] };
}

function jsonResult(value: unknown, isError = false): ToolResult {
    return textResult(JSON.stringify(value, null, 2), isError);
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function packageDependencies(manifest: PackageManifest): Set<string> {
    return new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
    ]);
}

function outputDirectoryFor(manifest: PackageManifest): string {
    const dependencies = packageDependencies(manifest);
    if (dependencies.has("next")) return "out";
    if (dependencies.has("@sveltejs/kit") || dependencies.has("svelte")) return "build";
    return "dist";
}

async function readPackageManifest(root: string): Promise<PackageManifest> {
    const path = join(root, "package.json");
    if (!existsSync(path)) return {};
    try {
        const parsed = JSON.parse(await readFile(path, "utf8"));
        const value = record(parsed);
        if (!value) throw new Error("package.json must contain an object");
        const scripts = record(value.scripts);
        const dependencies = record(value.dependencies);
        const devDependencies = record(value.devDependencies);
        return {
            scripts: scripts ?? undefined,
            dependencies: dependencies ?? undefined,
            devDependencies: devDependencies ?? undefined,
        };
    } catch (error) {
        throw new Error(`Invalid package.json: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function writeNewFile(path: string, content: string): Promise<boolean> {
    try {
        await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        return true;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
        throw error;
    }
}

async function ensureGitignore(root: string): Promise<boolean> {
    const path = join(root, ".gitignore");
    const existing = existsSync(path) ? await readFile(path, "utf8") : "";
    const required = [".env.supacloud.*", "!.env.supacloud.*.example"];
    const missing = required.filter((entry) => !existing.split(/\r?\n/).includes(entry));
    if (missing.length === 0) return false;
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? `${existing}\n` : existing;
    await writeFile(path, `${prefix}${missing.join("\n")}\n`, "utf8");
    return true;
}

async function initializeProject(request: InitRequest, options: DeveloperExperienceOptions): Promise<ToolResult> {
    const root = resolve(request.root || options.cwd || process.cwd());
    await mkdir(root, { recursive: true });
    const configPath = join(root, "supacloud.json");
    if (existsSync(configPath)) {
        throw new Error(`supacloud.json already exists in ${root}; init never overwrites project configuration`);
    }

    const manifest = await readPackageManifest(root);
    const hasBuildScript = typeof manifest.scripts?.build === "string" && Boolean(manifest.scripts.build.trim());
    const outputDirectory = outputDirectoryFor(manifest);
    const config = {
        frontend: {
            root: ".",
            outputDirectory,
        },
    };
    const created: string[] = [];
    try {
        await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o644,
        });
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") {
            throw new Error(`supacloud.json already exists in ${root}; init never overwrites project configuration`);
        }
        throw error;
    }
    created.push("supacloud.json");

    if (await writeNewFile(join(root, ".env.supacloud.test.example"), TEST_PROFILE)) {
        created.push(".env.supacloud.test.example");
    }
    if (await writeNewFile(join(root, ".env.supacloud.production.example"), PRODUCTION_PROFILE)) {
        created.push(".env.supacloud.production.example");
    }
    if (await ensureGitignore(root)) created.push(".gitignore");

    const result = {
        schema: "supacloud.developer-experience.init.v1",
        ok: true,
        root,
        created,
        detected: {
            package_json: existsSync(join(root, "package.json")),
            build_script: hasBuildScript,
            output_directory: outputDirectory,
        },
        next: [
            "cp .env.supacloud.test.example .env.supacloud.test",
            "Set SUPACLOUD_APPLICATION_ID to the application's ID and configure its current SupaCloud delivery build.",
            "supacloud env check",
            "supacloud --env test deploy",
        ],
    };
    if (request.json === true) return jsonResult(result);
    return textResult([
        `Initialized SupaCloud deployment in ${root}.`,
        `Created: ${created.join(", ")}.`,
        hasBuildScript
            ? `Detected package.json build script; deploy output defaults to ${outputDirectory}.`
            : "No package.json build script detected; add one before deploying.",
        "",
        ...result.next,
    ].join("\n"));
}

function profileNameFromFile(name: string): string | null {
    const match = name.match(/^\.env\.supacloud\.([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/);
    return match?.[1] ?? null;
}

async function environmentProfiles(root: string): Promise<EnvironmentProfile[]> {
    const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
    });
    return entries
        .filter((entry) => entry.isFile())
        .map((entry) => {
            const name = profileNameFromFile(entry.name);
            return name ? { name, path: join(root, entry.name), exists: true as const } : null;
        })
        .filter((profile): profile is EnvironmentProfile => profile !== null)
        .sort((left, right) => left.name.localeCompare(right.name));
}

function statusMissing(context: ResolvedContext): string[] {
    if (context.credentialScope === "management") {
        return [
            !context.apiUrl ? "SUPACLOUD_API_URL" : null,
            !context.apiToken ? "SUPACLOUD_API_TOKEN" : null,
            !context.projectRef ? "SUPACLOUD_PROJECT_REF" : null,
        ].filter((value): value is string => value !== null);
    }
    if (context.credentialScope === "project_application") {
        return [
            !context.inferredSupabaseUrl ? "SUPABASE_URL" : null,
            !context.inferredServiceRoleKey ? "SUPABASE_SERVICE_ROLE_KEY" : null,
            !context.projectRef ? "SUPACLOUD_PROJECT_REF" : null,
        ].filter((value): value is string => value !== null);
    }
    return ["SUPACLOUD_API_URL", "SUPACLOUD_API_TOKEN", "SUPACLOUD_PROJECT_REF"];
}

function deployMissing(context: ResolvedContext, application?: Record<string, unknown> | null): string[] {
    const missing = statusMissing(context);
    if (context.credentialScope !== "management") {
        return [...missing, "Management API context"];
    }
    if (!Value.Check(ApplicationIdSchema, context.applicationId || application?.id)) {
        missing.push("valid SUPACLOUD_APPLICATION_ID or supacloud.json application.id");
    }
    if (!Value.Check(ApplicationIdSchema, context.applicationEnvironmentId || application?.environmentId)) {
        missing.push("valid SUPACLOUD_APPLICATION_ENVIRONMENT_ID or SUPACLOUD_ENV");
    }
    return missing;
}

async function inspectProfile(profile: EnvironmentProfile): Promise<EnvironmentReport> {
    try {
        const context = resolveSupaCloudContext({}, dirname(profile.path), {
            environmentName: profile.name,
        });
        const status = statusMissing(context);
        const configText = await readFile(join(dirname(profile.path), "supacloud.json"), "utf8")
            .catch((error: unknown) => {
                if (error instanceof Error && "code" in error && error.code === "ENOENT") return "{}";
                throw error;
            });
        const config = record(JSON.parse(configText));
        const deploy = deployMissing(context, record(config?.application));
        return {
            name: profile.name,
            path: profile.path,
            environment: context.environment || null,
            production: context.production,
            source: "named_env_file",
            credentialScope: context.credentialScope,
            projectRef: context.projectRef || null,
            statusReady: status.length === 0,
            statusMissing: status,
            deployReady: deploy.length === 0,
            deployMissing: deploy,
            hasApiToken: Boolean(context.apiToken),
            hasServiceRoleKey: Boolean(context.inferredServiceRoleKey),
            error: null,
        };
    } catch (error) {
        return {
            name: profile.name,
            path: profile.path,
            environment: null,
            production: false,
            source: "invalid",
            credentialScope: "incomplete",
            projectRef: null,
            statusReady: false,
            statusMissing: [],
            deployReady: false,
            deployMissing: [],
            hasApiToken: false,
            hasServiceRoleKey: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

async function inspectEnvironment(request: EnvironmentRequest, options: DeveloperExperienceOptions): Promise<ToolResult> {
    const root = resolve(request.root || options.cwd || process.cwd());
    const profiles = await environmentProfiles(root);
    if (request.action === "list") {
        const active = options.activeContext?.environment || null;
        const result = {
            schema: "supacloud.developer-experience.environments.v1",
            ok: true,
            root,
            active,
            environments: profiles.map((profile) => ({
                name: profile.name,
                path: profile.path,
                active: profile.name.toLowerCase() === active?.toLowerCase(),
            })),
        };
        if (request.json === true) return jsonResult(result);
        if (profiles.length === 0) {
            return textResult(`No .env.supacloud.<name> profiles found in ${root}.\nRun \`supacloud init\` to create safe examples.`);
        }
        return textResult([
            `Environment profiles in ${root}:`,
            ...result.environments.map((profile) => `${profile.active ? "*" : " "} ${profile.name}  ${profile.path}`),
        ].join("\n"));
    }

    const reports = await Promise.all(profiles.map((profile) => inspectProfile(profile)));
    const result = {
        schema: "supacloud.developer-experience.environment-check.v1",
        ok: reports.length > 0 && reports.every((report) => report.statusReady),
        root,
        active: options.activeContext?.environment || null,
        environments: reports,
    };
    if (request.json === true) return jsonResult(result, !result.ok);
    if (reports.length === 0) {
        return textResult(`No environment profiles found in ${root}.\nRun \`supacloud init\` and copy an example profile.`, true);
    }
    const lines = reports.map((report) => {
        if (report.error) return `FAIL ${report.name}: ${report.error}`;
        const status = report.statusReady ? "OK" : `FAIL missing ${report.statusMissing.join(", ")}`;
        const deploy = report.deployReady ? "deploy=ready" : `deploy=blocked(${report.deployMissing.join(", ")})`;
        const ref = report.projectRef ? `project=${report.projectRef}` : "project=unknown";
        return `${status}  ${report.name}  ${deploy}  ${ref}`;
    });
    return textResult(lines.join("\n"), !result.ok);
}

export function registerDeveloperExperienceTools(
    server: ToolServer,
    options: DeveloperExperienceOptions = {},
): void {
    registerTool(
        server,
        "init",
        "Create SupaCloud deployment configuration and non-secret environment examples without overwriting project files.",
        initToolSchema,
        (request) => initializeProject(request, options),
    );
    registerTool(
        server,
        "env",
        "List or locally validate named SupaCloud environment profiles without contacting the platform or printing secrets.",
        environmentToolSchema,
        (request) => inspectEnvironment(request as unknown as EnvironmentRequest, options),
    );
}

export const __internal = {
    outputDirectoryFor,
    profileNameFromFile,
    statusMissing,
    deployMissing,
};
