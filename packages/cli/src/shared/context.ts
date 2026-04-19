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

export function resolveSupaCloudContext(
    env: NodeJS.ProcessEnv = process.env,
    cwd: string = process.cwd(),
): ResolvedContext {
    const dotenv = readDotEnvFile(cwd);
    const inferredUrl = pickValue(env, dotenv, ["SUPABASE_URL", "SUPACLOUD_API_URL"]);
    const inferredToken = pickValue(env, dotenv, ["SUPABASE_SERVICE_ROLE_KEY", "SUPACLOUD_API_TOKEN"]);

    const hostFromEnv = env.SUPACLOUD_HOST;
    const hostFromUrl = inferredUrl.value ? new URL(inferredUrl.value).hostname : "";

    return {
        host: hostFromEnv ?? hostFromUrl,
        sshUser: env.SUPACLOUD_SSH_USER ?? "root",
        sshPort: parseInt(env.SUPACLOUD_SSH_PORT ?? "22", 10),
        sshKey: env.SUPACLOUD_SSH_KEY ?? resolve(homedir(), ".ssh", "id_rsa"),
        sshPass: env.SUPACLOUD_SSH_PASS ?? "",
        apiUrl: env.SUPACLOUD_API_URL ?? (inferredUrl.value ? inferredUrl.value.replace(/\/+$/, "") : (hostFromEnv ? `http://${hostFromEnv}:9090` : "")),
        apiToken: env.SUPACLOUD_API_TOKEN ?? inferredToken.value,
        projectRef: env.SUPACLOUD_PROJECT_REF ?? "",
        readOnly: env.SUPACLOUD_READ_ONLY === "true",
        inferredSupabaseUrl: inferredUrl.value,
        inferredServiceRoleKey: inferredToken.value,
        source: detectSource([
            inferredUrl.value ? inferredUrl.source : "none",
            inferredToken.value ? inferredToken.source : "none",
        ]),
    };
}
