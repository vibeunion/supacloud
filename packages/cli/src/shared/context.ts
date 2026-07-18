import { homedir } from "node:os";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export interface ResolvedContext {
    host: string;
    sshUser: string;
    sshPort: number;
    sshKey: string;
    sshPass: string;
    apiUrl: string;
    apiToken: string;
    projectRef: string;
    readOnly: boolean;
    inferredSupabaseUrl: string;
    inferredServiceRoleKey: string;
    source: "env" | "dotenv" | "mixed" | "none";
}

interface EnvLookupResult {
    value: string;
    source: "env" | "dotenv";
}

function readDotEnvFile(cwd: string): Record<string, string> {
    const envPath = resolve(cwd, ".env");
    if (!existsSync(envPath)) return {};

    const values: Record<string, string> = {};
    try {
        const envContent = readFileSync(envPath, "utf-8");
        for (const line of envContent.split("\n")) {
            const match = line.trim().match(/^([^=]+)=(.*)$/);
            if (!match) continue;
            const key = match[1].trim();
            const value = match[2].trim().replace(/^["']|["']$/g, "");
            values[key] = value;
        }
    } catch {
        return {};
    }
    return values;
}

function pickValue(
    env: NodeJS.ProcessEnv,
    dotenv: Record<string, string>,
    keys: string[],
): EnvLookupResult {
    for (const key of keys) {
        const envValue = env[key];
        if (envValue) return { value: envValue, source: "env" };
    }
    for (const key of keys) {
        const dotenvValue = dotenv[key];
        if (dotenvValue) return { value: dotenvValue, source: "dotenv" };
    }
    return { value: "", source: "env" };
}

function detectSource(sources: Array<"env" | "dotenv" | "none">): ResolvedContext["source"] {
    const present = new Set(sources.filter((value) => value !== "none"));
    if (present.size === 0) return "none";
    if (present.size === 1) return present.has("env") ? "env" : "dotenv";
    return "mixed";
}

function normalizeUrl(value: string): string {
    const trimmed = value.trim().replace(/\/+$/, "");
    if (!trimmed) return "";
    try {
        return new URL(trimmed).toString().replace(/\/+$/, "");
    } catch {
        return "";
    }
}

function hostFromUrl(value: string): string {
    try {
        return new URL(value).hostname;
    } catch {
        return "";
    }
}

function inferProjectRefFromSupabaseUrl(value: string): string {
    const normalized = normalizeUrl(value);
    if (!normalized) return "";

    const match = new URL(normalized).hostname.match(/^([a-z0-9-]+)\.api\./i);
    return match?.[1] ?? "";
}

function inferManagementApiUrlFromSupabaseUrl(value: string, projectRef = ""): string {
    const normalized = normalizeUrl(value);
    if (!normalized) return "";

    const url = new URL(normalized);
    const host = url.hostname;
    if (host.startsWith("api.")) {
        url.hostname = `studio.${host.slice("api.".length)}`;
        return url.toString().replace(/\/+$/, "");
    }

    const ref = projectRef.trim();
    if (ref && host.startsWith(`${ref}.api.`)) {
        url.hostname = `studio-${ref}.${host.slice(`${ref}.api.`.length)}`;
        return url.toString().replace(/\/+$/, "");
    }

    const managedHostMatch = host.match(/^([a-z0-9-]+)\.api\.(.+)$/i);
    if (managedHostMatch) {
        url.hostname = `studio-${managedHostMatch[1]}.${managedHostMatch[2]}`;
        return url.toString().replace(/\/+$/, "");
    }

    return normalized;
}

export function resolveSupaCloudContext(
    env: NodeJS.ProcessEnv = process.env,
    cwd: string = process.cwd(),
): ResolvedContext {
    const dotenv = readDotEnvFile(cwd);
    const supabaseUrl = pickValue(env, dotenv, ["SUPABASE_URL"]);
    const explicitApiUrl = pickValue(env, dotenv, ["SUPACLOUD_API_URL", "SUPACLOUD_MANAGEMENT_API_URL", "MANAGEMENT_API_URL"]);
    const inferredToken = pickValue(env, dotenv, ["SUPABASE_SERVICE_ROLE_KEY", "SUPACLOUD_API_TOKEN"]);
    const explicitProjectRef = pickValue(env, dotenv, ["SUPACLOUD_PROJECT_REF", "X_PROJECT_REF"]).value;

    const hostFromEnv = env.SUPACLOUD_HOST;
    const normalizedSupabaseUrl = normalizeUrl(supabaseUrl.value);
    const projectRef = explicitProjectRef || inferProjectRefFromSupabaseUrl(normalizedSupabaseUrl);
    const apiUrl = normalizeUrl(explicitApiUrl.value)
        || inferManagementApiUrlFromSupabaseUrl(normalizedSupabaseUrl, projectRef)
        || (hostFromEnv ? `http://${hostFromEnv}:9090` : "");
    const resolvedHostFromUrl = hostFromUrl(apiUrl || normalizedSupabaseUrl);

    return {
        host: hostFromEnv ?? resolvedHostFromUrl,
        sshUser: env.SUPACLOUD_SSH_USER ?? "root",
        sshPort: parseInt(env.SUPACLOUD_SSH_PORT ?? "22", 10),
        sshKey: env.SUPACLOUD_SSH_KEY ?? resolve(homedir(), ".ssh", "id_rsa"),
        sshPass: env.SUPACLOUD_SSH_PASS ?? "",
        apiUrl,
        apiToken: env.SUPACLOUD_API_TOKEN ?? inferredToken.value,
        projectRef,
        readOnly: env.SUPACLOUD_READ_ONLY === "true",
        inferredSupabaseUrl: normalizedSupabaseUrl,
        inferredServiceRoleKey: inferredToken.value,
        source: detectSource([
            (supabaseUrl.value || explicitApiUrl.value) ? (supabaseUrl.value ? supabaseUrl.source : explicitApiUrl.source) : "none",
            inferredToken.value ? inferredToken.source : "none",
        ]),
    };
}
