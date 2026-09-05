import { isValidCaddyDomain, normalizeCaddyHost } from "./caddy-domains";
import type { FrontendDeployment } from "../types/frontend";

export const MASKED_FRONTEND_VALUE = "********";

const RESERVED_FRONTEND_ENV_NAMES = new Set([
  "PATH",
  "PWD",
  "OLDPWD",
  "SHELL",
  "BASH_ENV",
  "ENV",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "NODE_VERSION",
  "DATABASE_URL",
  "MASTER_TOKEN",
  "JWT_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SECRET_KEY",
  "NPM_TOKEN",
]);
const RESERVED_FRONTEND_ENV_PREFIXES = ["SUPACLOUD_", "SUPAOAUTH_", "AWS_SECRET"];

function normalizeFrontendHost(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) return "";
    return normalizeCaddyHost(parsed.hostname);
  }
  if (/[/?#]/.test(trimmed)) return "";
  return normalizeCaddyHost(trimmed);
}

function assertSafeFrontendEnvName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid frontend environment variable name: ${name}`);
  }
  const normalized = name.toUpperCase();
  if (
    RESERVED_FRONTEND_ENV_NAMES.has(normalized)
    || RESERVED_FRONTEND_ENV_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  ) {
    throw new Error(`Reserved frontend environment variable name: ${name}`);
  }
}

export function normalizeFrontendEnvVars(
  envVars: Record<string, string> | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(envVars || {})) {
    assertSafeFrontendEnvName(name);
    if (typeof value !== "string" || value.length > 24_576 || /[\u0000\r\n]/.test(value)) {
      throw new Error(`Frontend environment variable is too large: ${name}`);
    }
    normalized[name] = value;
  }
  if (Object.keys(normalized).length > 256) {
    throw new Error("Frontend environment variable count exceeds 256");
  }
  return normalized;
}

export function normalizeFrontendCustomDomain(domain: string): string {
  const normalized = normalizeFrontendHost(domain);
  if (!isValidCaddyDomain(normalized)) throw new Error("Invalid custom domain");
  return normalized;
}

export function normalizeFrontendCustomDomains(domains: string[] | undefined): string[] {
  return [...new Set((domains || []).map(normalizeFrontendCustomDomain))];
}

export function normalizeFrontendCertificateDomain(domain: string): string {
  const normalized = normalizeFrontendHost(domain);
  const candidate = normalized.startsWith("*.") ? normalized.slice(2) : normalized;
  if (!isValidCaddyDomain(candidate)) throw new Error("Invalid certificate domain");
  return normalized;
}

export function maskFrontendBuildLog(
  log: string | undefined,
  secretValues: Iterable<string> = [],
): string {
  let masked = log || "";
  for (const secret of secretValues) {
    if (secret.length >= 4) masked = masked.split(secret).join("********");
  }
  return masked
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^/@\s]+@/gi, "$1********@")
    .replace(
      /((?:token|secret|password|passwd|api[_-]?key|authorization)\s*[=:]\s*)([^\s,;]+)/gi,
      "$1********",
    );
}

export function sanitizeFrontendGitUrl(gitUrl: string): string {
  try {
    const parsed = new URL(gitUrl);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return gitUrl.replace(/:\/\/[^/@\s]+@/g, "://********@");
  }
}

export function normalizeFrontendOutputDir(outputDir: string | undefined): string {
  const requested = (outputDir ?? "").trim();
  if (!requested || requested.startsWith("/") || requested.startsWith("\\")
    || requested.split(/[\\/]/).includes("..")) {
    throw new Error("Frontend output_dir must be a relative path without parent traversal");
  }
  return requested;
}

export function toFrontendDeploymentResponse(deployment: FrontendDeployment): Omit<FrontendDeployment, "deploy_tokens" | "env_vars" | "build_log"> & {
  env_vars: Record<string, string>;
  deploy_tokens: Array<{ id: string; name: string; created_at: string; last_used_at?: string }>;
} {
  const { deploy_tokens, env_vars, build_log: _buildLog, ...safeDeployment } = deployment;
  if (safeDeployment.git_url) {
    safeDeployment.git_url = sanitizeFrontendGitUrl(safeDeployment.git_url);
  }
  return {
    ...safeDeployment,
    env_vars: Object.fromEntries(
      Object.keys(env_vars || {}).map((name) => [name, MASKED_FRONTEND_VALUE]),
    ),
    deploy_tokens: (deploy_tokens || []).map(({ id, name, created_at, last_used_at }) => ({
      id,
      name,
      created_at,
      last_used_at,
    })),
  };
}
