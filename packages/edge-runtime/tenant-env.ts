/**
 * Load tenant-specific environment variables for Edge Function execution.
 *
 * Priority (last write wins):
 *   1. Static file: /etc/supabase/tenants/{ref}.env (base config, PostgREST etc.)
 *   2. Database: project_secrets table via Management API (user-managed Secrets)
 *
 * Secrets from DB are fetched on every function invocation — no restart needed
 * when users update secrets via Dashboard/MCP/API.
 */

const TENANTS_DIRS = [
  process.env.TENANTS_DIR,
  process.env.TENANT_CONFIG_DIR,
  "/opt/supabase/volumes/api/kong_tenants", // management API default
  "/etc/supabase/tenants", // legacy fallback
].filter(Boolean) as string[];

const MGMT_API = process.env.MANAGEMENT_API_URL || "http://127.0.0.1:9090";
const MASTER_TOKEN = process.env.MASTER_TOKEN || "";

// In-memory cache with TTL to avoid hammering the API on rapid requests
const cache = new Map<
  string,
  { env: Record<string, string>; expiresAt: number }
>();
const CACHE_TTL_MS = 5_000; // 5 seconds — short enough to feel "instant" on update

/** Load env from static .env file (base layer), trying multiple directories in order */
async function loadEnvFile(
  projectRef: string,
): Promise<Record<string, string>> {
  const envMap: Record<string, string> = {};
  for (const dir of TENANTS_DIRS) {
    try {
      const text = await Bun.file(`${dir}/${projectRef}.env`).text();
      for (const line of text.split("\n")) {
        const match = line.match(/^([^#=][^=]*)=(.*)$/);
        if (match) {
          envMap[match[1].trim()] = match[2].trim();
        }
      }
      // Found a file, stop searching
      break;
    } catch {
      // Try next directory
    }
  }
  return envMap;
}

/** Load secrets from Management API (database-backed, user-managed) */
async function loadSecretsFromApi(
  projectRef: string,
): Promise<Record<string, string>> {
  const envMap: Record<string, string> = {};
  if (!MASTER_TOKEN) return envMap; // Can't query without auth

  try {
    const res = await fetch(`${MGMT_API}/v1/projects/${projectRef}/secrets`, {
      headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
      signal: AbortSignal.timeout(3000), // Don't block function execution
    });
    if (res.ok) {
      const secrets: { name: string; value: string }[] = await res.json();
      for (const s of secrets) {
        envMap[s.name] = s.value;
      }
    }
  } catch {
    // API unreachable — proceed with file-only env
  }
  return envMap;
}

/** Main entry: load tenant env with caching */
export async function loadTenantEnv(
  projectRef: string,
): Promise<Record<string, string>> {
  // Check cache
  const cached = cache.get(projectRef);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.env;
  }

  // Layer 1: static file
  const fileEnv = await loadEnvFile(projectRef);
  // Layer 2: DB secrets (overrides file values)
  const dbEnv = await loadSecretsFromApi(projectRef);

  const merged = { ...fileEnv, ...dbEnv };

  // Cache result
  cache.set(projectRef, { env: merged, expiresAt: Date.now() + CACHE_TTL_MS });

  return merged;
}
