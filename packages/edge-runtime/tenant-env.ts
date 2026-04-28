const MGMT_API = process.env.MANAGEMENT_API_URL || "http://127.0.0.1:9090";
const MASTER_TOKEN = process.env.EDGE_RUNTIME_MASTER_KEY || process.env.MASTER_TOKEN || "";

const TENANTS_DIRS = [
  process.env.TENANTS_DIR || "/etc/supabase/tenants",
  "/opt/supacloud/tenants",
];

const envCache = new Map<string, { env: Record<string, string>; expiresAt: number }>();
const ENV_CACHE_TTL = 5_000;

function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    let value = rawValue.trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const inlineComment = value.match(/\s+#.*$/);
      if (inlineComment) {
        value = value.slice(0, inlineComment.index).trimEnd();
      }
    }

    env[key] = value;
  }
  return env;
}

async function loadEnvFromFile(ref: string): Promise<Record<string, string>> {
  for (const dir of TENANTS_DIRS) {
    const envPath = `${dir}/${ref}.env`;
    try {
      const file = Bun.file(envPath);
      if (await file.exists()) {
        const content = await file.text();
        return parseEnvFile(content);
      }
    } catch {}
  }
  return {};
}

async function loadEnvFromApi(ref: string): Promise<Record<string, string> | null> {
  try {
    const res = await fetch(`${MGMT_API}/v1/projects/${ref}/secrets?reveal=true`, {
      headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.warn(
        `[tenant-env] API returned ${res.status} for ${ref}, falling back to stale cache or file`
      );
      return null;
    }

    const secrets = (await res.json()) as Array<{
      name: string;
      value: string;
    }>;
    const env: Record<string, string> = {};
    for (const s of secrets) {
      env[s.name] = s.value;
    }
    return env;
  } catch (err) {
    console.warn(
      `[tenant-env] API error for ${ref}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function loadTenantEnv(ref: string): Promise<Record<string, string>> {
  const cached = envCache.get(ref);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.env;
  }

  const fileEnv = await loadEnvFromFile(ref);

  const apiEnv = await loadEnvFromApi(ref);
  if (apiEnv === null) {
    if (cached) {
      return { ...fileEnv, ...cached.env };
    }
    return fileEnv;
  }

  const merged = { ...fileEnv, ...apiEnv };

  envCache.set(ref, { env: merged, expiresAt: Date.now() + ENV_CACHE_TTL });
  return merged;
}

export function invalidateTenantEnvCache(ref: string) {
  envCache.delete(ref);
}
