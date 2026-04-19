import { config } from "../src/config";
import { sql, resolveDbName, resolveRoleName } from "../src/db";
import { logger } from "../src/utils/logger";

type ProjectRow = {
  ref: string;
  db_name: string | null;
  db_user: string | null;
  db_password: string | null;
  jwt_secret: string | null;
  config?: unknown;
};

type TenantLookupResponse = {
  data?: Array<{ external_id?: string }> | { external_id?: string } | null;
  error?: string;
};

function adminJwt(secret: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      iss: "supabase",
      role: "supabase_admin",
      iat: now,
      exp: now + 3600,
    }),
  ).toString("base64url");
  const signature = Bun.CryptoHasher.hmac(
    "sha256",
    secret,
    `${header}.${payload}`,
    "base64url",
  );
  return `${header}.${payload}.${signature}`;
}

async function realtimeFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const base = config.realtimeAdminUrl.replace(/\/+$/, "");
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminJwt(
        config.realtimeApiSecret || config.jwtSecret,
      )}`,
      ...(init?.headers || {}),
    },
  });
}

async function getTenant(projectRef: string): Promise<boolean> {
  const res = await realtimeFetch(`/api/tenants/${projectRef}`, {
    method: "GET",
  });
  return res.ok;
}

function projectRoutingConfig(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input === "string" && input.trim()) {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore malformed legacy config
    }
  }
  return {};
}

function pickRoutingHost(projectRef: string, projectConfig: unknown): string {
  const routing = projectRoutingConfig(projectConfig);
  const host =
    typeof routing.api_domain === "string" && routing.api_domain.trim()
      ? routing.api_domain.trim()
      : `${projectRef}.supabase.co`;
  return host;
}

async function registerTenant(project: ProjectRow): Promise<void> {
  const dbName = project.db_name || (await resolveDbName(project.ref));
  const dbUser = project.db_user || resolveRoleName(project.ref);
  const dbPassword = project.db_password || config.pgPassword;
  const jwtSecret = project.jwt_secret;

  if (!dbPassword || !jwtSecret) {
    throw new Error(
      `missing credentials for ${project.ref} (db_password/jwt_secret)`,
    );
  }

  const payload = {
    tenant: {
      external_id: project.ref,
      name: `Project ${project.ref}`,
      jwt_secret: jwtSecret,
      extensions: [
        {
          type: "postgres_cdc_rls",
          settings: {
            db_host: config.pgHost,
            db_port: String(config.pgPort),
            db_name: dbName,
            db_user: dbUser,
            db_password: dbPassword,
            region: "us-east-1",
            poll_interval_ms: 100,
            poll_max_changes: 100,
            poll_max_record_bytes: 1_048_576,
            slot_name: `supabase_realtime_rls_${project.ref}`,
            publication: "supabase_realtime",
          },
        },
      ],
    },
  };

  const res = await realtimeFetch("/api/tenants", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (!res.ok && res.status !== 409) {
    const body = await res.text();
    throw new Error(`register failed (${res.status}): ${body}`);
  }

  const host = pickRoutingHost(project.ref, project.config);
  logger.info("[RealtimeReconcile] tenant registered", {
    projectRef: project.ref,
    apiHost: host,
  });
}

async function main() {
  const rows = await sql<ProjectRow[]>`
    SELECT ref, db_name, db_user, db_password, jwt_secret, config
    FROM projects
    WHERE status IS NULL OR status <> 'deleted'
    ORDER BY ref
  `;

  logger.info("[RealtimeReconcile] scanning projects", {
    total: rows.length,
    realtimeAdminUrl: config.realtimeAdminUrl,
  });

  let created = 0;
  let skipped = 0;
  const failed: Array<{ ref: string; error: string }> = [];

  for (const project of rows) {
    try {
      if (await getTenant(project.ref)) {
        skipped += 1;
        logger.info("[RealtimeReconcile] tenant already present", {
          projectRef: project.ref,
        });
        continue;
      }

      await registerTenant(project);
      created += 1;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      failed.push({ ref: project.ref, error: message });
      logger.error("[RealtimeReconcile] tenant registration failed", {
        projectRef: project.ref,
        error: message,
      });
    }
  }

  logger.info("[RealtimeReconcile] complete", {
    created,
    skipped,
    failed: failed.length,
  });

  if (failed.length > 0) {
    console.error(JSON.stringify({ failed }, null, 2));
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    logger.error("[RealtimeReconcile] fatal", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
