import { config } from "../src/config";
import { sql, resolveDbName, resolveSlotName } from "../src/db";
import { buildRealtimeTenantPayload } from "../src/services/realtime-tenant-payload";
import { logger } from "../src/utils/logger";
import { createHmac } from "node:crypto";

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
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
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

async function authoritativeTenantPayload(project: ProjectRow) {
  const dbName = project.db_name || (await resolveDbName(project.ref));
  const dbPassword = config.pgPassword || project.db_password;
  const jwtSecret = project.jwt_secret;

  if (!dbPassword || !jwtSecret) {
    throw new Error(
      `missing credentials for ${project.ref} (db_password/jwt_secret)`,
    );
  }

  return buildRealtimeTenantPayload({
    projectRef: project.ref,
    dbHost: config.pgHost,
    dbPort: String(config.pgPort),
    dbName,
    adminDbPassword: dbPassword,
    jwtSecret,
    slotName: resolveSlotName(project.ref),
  });
}

async function registerTenant(project: ProjectRow): Promise<void> {
  const payload = await authoritativeTenantPayload(project);

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

async function updateTenant(project: ProjectRow): Promise<void> {
  const payload = await authoritativeTenantPayload(project);

  const res = await realtimeFetch(`/api/tenants/${project.ref}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`update failed (${res.status}): ${body}`);
  }

  const host = pickRoutingHost(project.ref, project.config);
  logger.info("[RealtimeReconcile] tenant updated", {
    projectRef: project.ref,
    apiHost: host,
  });
}

async function upsertTenant(project: ProjectRow): Promise<"created" | "updated"> {
  const exists = await getTenant(project.ref);
  if (exists) {
    await updateTenant(project);
    return "updated";
  }
  await registerTenant(project);
  return "created";
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
  let updated = 0;
  const failed: Array<{ ref: string; error: string }> = [];

  for (const project of rows) {
    try {
      const action = await upsertTenant(project);
      if (action === "created") {
        created += 1;
      } else {
        updated += 1;
      }
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
    updated,
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
