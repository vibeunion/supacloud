import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { optional, stringEnum, withDescription } from "../schema";
import type { ToolSchema } from "../schema";
import { registerTool, type ToolResult, type ToolServer } from "../tool-server";
import type { ResolvedContext } from "../context";

export interface ConfigurationToolOptions {
    cwd?: string;
    activeContext?: ResolvedContext;
}

const MANAGEMENT_CONFIGURATION_KEYS = ["SUPACLOUD_API_URL", "SUPACLOUD_API_TOKEN", "SUPACLOUD_PROJECT_REF"] as const;
const APPLICATION_CONFIGURATION_KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPACLOUD_PROJECT_REF"] as const;

export const onboardToolSchema: ToolSchema = {
    root: optional(Type.String(), "Repository or configuration root (default: current directory)"),
    profile: optional(stringEnum(["solo", "podman", "pigsty", "cluster"]), "Deployment profile (default: solo)"),
    domain: optional(Type.String(), "Public API domain; studio domain is derived from it"),
    database: optional(stringEnum(["local", "external"]), "Database provider (default: local)"),
    storage: optional(stringEnum(["juicefs", "external"]), "Storage provider (default: juicefs)"),
    write: optional(Type.Boolean(), "Write the generated context into supacloud.json"),
    format: optional(stringEnum(["text", "json"]), "Output format (default: text)"),
};

export const configurationToolSchema: ToolSchema = {
    action: withDescription(stringEnum(["doctor", "explain"]), "Configuration inspection action"),
    root: optional(Type.String(), "Repository or configuration root (default: current directory)"),
    key: optional(Type.String(), "[explain] Environment variable name"),
    format: optional(stringEnum(["text", "json"]), "Output format (default: text)"),
};

export const environmentSyncSchema: ToolSchema = {
    action: withDescription(stringEnum(["list", "check", "sync"]), "Environment profile action"),
    root: optional(Type.String(), "Project directory containing .env.supacloud.* files"),
    environment: optional(Type.String(), "[sync] Profile name; defaults to the selected environment"),
    write: optional(Type.Boolean(), "[sync] Persist derived context and the reduced profile example"),
    format: optional(stringEnum(["text", "json"]), "Output format (default: text)"),
};

const SECRET_KEY = /(?:PASSWORD|PASS|SECRET|TOKEN|PRIVATE|CREDENTIAL|AUTHORIZATION|COOKIE|SESSION|DATABASE_URL|CONNECTION_STRING|DSN)/i;
const PLATFORM_KEY = /^(?:SUPACLOUD|SUPABASE)_(?:API|PROJECT|ENV|HOST|SSH|APPLICATION|SERVICE_ROLE|ACCESS|URL|READ_ONLY|TLS|ANON|PUBLISHABLE)/;

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

function unquote(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length >= 2 && ((trimmed.startsWith("\"") && trimmed.endsWith("\""))
        || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

function parseEnvironment(content: string): Record<string, string> {
    const values: Record<string, string> = {};
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (match) values[match[1]] = unquote(match[2]);
    }
    return values;
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    const value = record(parsed);
    if (!value) throw new Error(`${path} must contain a JSON object`);
    return value;
}

async function writeJsonObject(path: string, value: Record<string, unknown>): Promise<void> {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
}

function contextFromConfig(config: Record<string, unknown>): Record<string, unknown> {
    const context = record(config.context);
    return context ?? {};
}

function environmentContext(config: Record<string, unknown>, environment: string): Record<string, unknown> {
    const context = contextFromConfig(config);
    const environments = record(context.environments);
    const selected = environments ? record(environments[environment]) : null;
    return selected ?? {};
}

function derivedValues(values: Record<string, string>): Record<string, string> {
    const derived: Record<string, string> = {};
    const publicDomain = values.SUPABASE_PUBLIC_DOMAIN?.trim();
    if (publicDomain && !values.SUPABASE_STUDIO_DOMAIN) {
        derived.SUPABASE_STUDIO_DOMAIN = `studio.${publicDomain.replace(/^api\./, "")}`;
    }
    if (publicDomain && !values.SUPABASE_PUBLIC_URL) {
        derived.SUPABASE_PUBLIC_URL = `https://${publicDomain}`;
    }
    const host = values.SUPACLOUD_HOST?.trim();
    if (host && !values.SUPACLOUD_API_URL) {
        derived.SUPACLOUD_API_URL = `http://${host}:9090`;
    }
    if (values.SUPACLOUD_DEPLOYMENT_PROFILE === undefined) {
        derived.SUPACLOUD_DEPLOYMENT_PROFILE = "solo";
    }
    if (!values.S3_STORAGE_TYPE) derived.S3_STORAGE_TYPE = "juicefs";
    return derived;
}

function classify(name: string, value: string | undefined): "secret" | "platform" | "override" | "default" {
    if (SECRET_KEY.test(name)) return "secret";
    if (PLATFORM_KEY.test(name)) return "platform";
    if (value === undefined || value === "") return "default";
    return "override";
}

function configurationEntries(values: Record<string, string>): Array<Record<string, unknown>> {
    const derived = derivedValues(values);
    const names = [...new Set([...Object.keys(values), ...Object.keys(derived)])].sort();
    return names.map(name => {
        const value = values[name] ?? derived[name];
        const kind = derived[name] !== undefined && values[name] === undefined ? "derived" : classify(name, values[name]);
        return {
            name,
            kind,
            source: kind === "derived" ? "platform-default" : (values[name] === undefined ? "absent" : "profile"),
            configured: value !== undefined && value !== "",
            value: kind === "secret" ? (value ? "********" : null) : (value ?? null),
        };
    });
}

function requiredConfigurationKeys(activeContext?: ResolvedContext): readonly string[] {
    return activeContext?.credentialScope === "project_application"
        ? APPLICATION_CONFIGURATION_KEYS
        : MANAGEMENT_CONFIGURATION_KEYS;
}

function parseSimpleYaml(content: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    let section: Record<string, unknown> | null = null;
    for (const rawLine of content.split(/\r?\n/)) {
        if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
        const match = rawLine.match(/^(\s*)([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
        if (!match) throw new Error("Unsupported YAML syntax; use simple key/value pairs");
        const indent = match[1].length;
        const key = match[2].replaceAll("-", "_");
        const rawValue = match[3].trim();
        if (indent === 0) {
            if (!rawValue) {
                const nested: Record<string, unknown> = {};
                result[key] = nested;
                section = nested;
            } else {
                result[key] = unquote(rawValue);
                section = null;
            }
            continue;
        }
        if (!section) throw new Error("Nested YAML key has no parent section");
        section[key] = unquote(rawValue);
    }
    return result;
}

export async function readBootstrapConfig(path: string): Promise<Record<string, unknown>> {
    const content = await readFile(resolve(path), "utf8");
    try {
        const parsed = record(JSON.parse(content));
        if (parsed) return parsed;
    } catch {
        // Fall through to the intentionally small, dependency-free YAML subset.
    }
    return parseSimpleYaml(content);
}

function onboardingPlan(args: Record<string, unknown>, root: string): Record<string, unknown> {
    const profile = typeof args.profile === "string" ? args.profile : "solo";
    const database = typeof args.database === "string" ? args.database : "local";
    const storage = typeof args.storage === "string" ? args.storage : "juicefs";
    const domain = typeof args.domain === "string" && args.domain.trim() ? args.domain.trim() : null;
    const required = ["profile"];
    if (domain === null) required.push("public_domain_or_explicit_ip");
    if (database === "external") required.push("database_url");
    if (storage === "external") required.push("s3_endpoint_and_credentials");
    return {
        schema: "supacloud.onboarding-plan.v1",
        root,
        profile,
        domain,
        database,
        storage,
        required_inputs: required,
        derived: {
            studio_domain: domain ? `studio.${domain.replace(/^api\./, "")}` : null,
            storage_backend: storage === "juicefs" ? "postgresql-large-object" : "external-s3",
            internal_service_urls: "allocated by the selected deployment profile",
            component_versions: "read from the verified release manifest",
        },
        writes: ["supacloud.json context metadata"],
        safety: [
            "unknown local PostgreSQL is never adopted automatically",
            "secret values are generated or injected and never printed",
            "external providers are requested only when selected",
        ],
    };
}

async function runOnboard(args: Record<string, unknown>, options: ConfigurationToolOptions): Promise<ToolResult> {
    const root = resolve(typeof args.root === "string" ? args.root : options.cwd ?? process.cwd());
    const plan = onboardingPlan(args, root);
    if (args.write === true) {
        await mkdir(root, { recursive: true });
        const path = join(root, "supacloud.json");
        const config = await readJsonObject(path);
        if (existsSync(path) && config.context !== undefined) {
            throw new Error("supacloud.json already has context metadata; use env sync to update one environment");
        }
        config.context = {
            default_environment: "test",
            deployment_profile: plan.profile,
            public_domain: plan.domain,
            database: plan.database,
            storage: plan.storage,
            environments: {},
        };
        await writeJsonObject(path, config);
        return jsonResult({ ...plan, ok: true, written: path });
    }
    return args.format === "json" ? jsonResult({ ...plan, ok: true, written: false }) : textResult([
        "SupaCloud onboarding plan",
        `profile: ${String(plan.profile)}`,
        `database: ${String(plan.database)}`,
        `storage: ${String(plan.storage)}`,
        `domain: ${plan.domain ?? "(required)"}`,
        "",
        "No files were changed. Re-run with --write after reviewing the plan.",
    ].join("\n"));
}

async function runConfiguration(args: Record<string, unknown>, options: ConfigurationToolOptions): Promise<ToolResult> {
    const root = resolve(typeof args.root === "string" ? args.root : options.cwd ?? process.cwd());
    const config = await readJsonObject(join(root, "supacloud.json"));
    const environment = options.activeContext?.environment || "";
    const profileValues = environment && existsSync(join(root, `.env.supacloud.${environment}`))
        ? parseEnvironment(await readFile(join(root, `.env.supacloud.${environment}`), "utf8"))
        : {};
    const metadata = environment ? environmentContext(config, environment) : {};
    const values: Record<string, string> = {
        ...Object.fromEntries(Object.entries(metadata).filter(([, value]) => typeof value === "string") as Array<[string, string]>),
        ...profileValues,
    };
    const entries = configurationEntries(Object.fromEntries([
        ...Object.entries(values),
        ...requiredConfigurationKeys(options.activeContext).map(name => [name, values[name] ?? ""]),
    ]));
    if (args.action === "explain") {
        const key = typeof args.key === "string" ? args.key.trim() : "";
        const selected = key ? entries.filter(entry => entry.name === key) : entries;
        return jsonResult({ schema: "supacloud.configuration.explain.v1", root, environment: environment || null, entries: selected });
    }
    const missing = entries.filter(entry => entry.configured === false).map(entry => entry.name);
    const secrets = entries.filter(entry => entry.kind === "secret").map(entry => entry.name);
    const result = {
        schema: "supacloud.configuration.doctor.v1",
        root,
        environment: environment || null,
        ok: missing.length === 0,
        missing,
        secret_names: secrets,
        entries,
        next: missing.length ? ["supacloud config explain"] : ["supacloud env sync --env test --write"],
    };
    return args.format === "json" ? jsonResult(result, !result.ok) : textResult([
        `Configuration: ${result.ok ? "OK" : "BLOCKED"}`,
        `environment: ${environment || "(none selected)"}`,
        missing.length ? `missing: ${missing.join(", ")}` : "missing: none",
        secrets.length ? `secrets: ${secrets.join(", ")}` : "secrets: none",
    ].join("\n"), !result.ok);
}

export async function syncEnvironmentProfile(args: Record<string, unknown>, options: ConfigurationToolOptions): Promise<ToolResult> {
    const root = resolve(typeof args.root === "string" ? args.root : options.cwd ?? process.cwd());
    const environment = typeof args.environment === "string" && args.environment.trim()
        ? args.environment.trim()
        : options.activeContext?.environment;
    if (!environment) throw new Error("env sync requires --env <name> or SUPACLOUD_ENV");
    const profilePath = join(root, `.env.supacloud.${environment}`);
    if (!existsSync(profilePath)) throw new Error(`Environment profile not found: ${profilePath}`);
    const values = parseEnvironment(await readFile(profilePath, "utf8"));
    const configPath = join(root, "supacloud.json");
    const config = await readJsonObject(configPath);
    const context = contextFromConfig(config);
    const environments = record(context.environments) ?? {};
    const publicValues = Object.fromEntries(Object.entries(values).filter(([name]) => !SECRET_KEY.test(name) && !PLATFORM_KEY.test(name)));
    const secretNames = Object.keys(values).filter(name => SECRET_KEY.test(name));
    const nextEnvironment = {
        api_url: values.SUPACLOUD_API_URL ?? null,
        project_ref: values.SUPACLOUD_PROJECT_REF ?? null,
        application_id: values.SUPACLOUD_APPLICATION_ID ?? null,
        environment_id: values.SUPACLOUD_APPLICATION_ENVIRONMENT_ID ?? environment,
        public: publicValues,
        secret_names: secretNames,
    };
    const result = {
        schema: "supacloud.environment-sync.v1",
        environment,
        profile: profilePath,
        config: configPath,
        diff: { changed: nextEnvironment, secret_values_written: false },
        next: ["Secret values are never copied into supacloud.json", `supacloud --env ${environment} status`],
    };
    if (args.write !== true) return jsonResult({ ...result, written: false });
    config.context = { ...context, environments: { ...environments, [environment]: nextEnvironment } };
    await writeJsonObject(configPath, config);
    const reducedExample = [`SUPACLOUD_ENV=${environment}`, "SUPACLOUD_API_TOKEN=<inject-at-runtime>", ""].join("\n");
    await writeFile(`${profilePath}.example`, reducedExample, { encoding: "utf8", mode: 0o600 });
    return jsonResult({ ...result, written: true, reduced_profile_example: `${profilePath}.example` });
}

export async function readSecretGap(root: string, environment: string): Promise<{
    environment: string;
    required: string[];
    present: string[];
    missing: string[];
}> {
    if (!environment) return { environment, required: [], present: [], missing: [] };
    const config = await readJsonObject(join(root, "supacloud.json"));
    const metadata = environmentContext(config, environment);
    const required = Array.isArray(metadata.secret_names)
        ? metadata.secret_names.filter((value): value is string => typeof value === "string" && /^[A-Z_][A-Z0-9_]*$/.test(value)).sort()
        : [];
    const profilePath = join(root, `.env.supacloud.${environment}`);
    const values = existsSync(profilePath) ? parseEnvironment(await readFile(profilePath, "utf8")) : {};
    const present = required.filter(name => values[name] !== undefined && values[name] !== "" && !/^<[^>]+>$/.test(values[name]));
    return { environment, required, present, missing: required.filter(name => !present.includes(name)) };
}

export function registerConfigurationTools(server: ToolServer, options: ConfigurationToolOptions = {}): void {
    registerTool(server, "onboard", "Preview or write a minimal SupaCloud onboarding plan.", onboardToolSchema,
        args => runOnboard(args as Record<string, unknown>, options));
    registerTool(server, "config", "Inspect configuration sources, derived values and missing inputs.", configurationToolSchema,
        args => runConfiguration(args as Record<string, unknown>, options));
}

export const __internal = {
    derivedValues,
    configurationEntries,
    onboardingPlan,
    parseSimpleYaml,
    parseEnvironment,
};
