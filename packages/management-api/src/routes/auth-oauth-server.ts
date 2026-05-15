import { Elysia, t, status } from "elysia";
import { projectService } from "../services";
import { tenantRuntimeService } from "../services/tenant-runtime.service";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { logger } from "../utils/logger";
import { resolveProjectServiceRoleKey } from "../utils/service-role";
import { sql as metaSql } from "../db";
import {
  normalizeProjectRoutingConfig,
  resolveProjectApiUrl,
  resolveTenantPorts,
} from "../utils/project-routing";
import { normalizeProjectConfig } from "../utils/project-config";
import {
  generateOidcJwtKeyMaterial,
  normalizeProjectJwtJwks,
  normalizeProjectJwtKeys,
} from "../utils/project-jwt";

const OAUTH_CLIENT_BODY = t.Object({
  redirect_uris: t.Array(t.String()),
  client_type: t.Optional(t.Union([t.Literal("public"), t.Literal("confidential")])),
  token_endpoint_auth_method: t.Optional(t.Union([
    t.Literal("none"),
    t.Literal("client_secret_basic"),
    t.Literal("client_secret_post"),
  ])),
  grant_types: t.Optional(t.Array(t.String())),
  client_name: t.Optional(t.String()),
  client_uri: t.Optional(t.String()),
  logo_uri: t.Optional(t.String()),
});

const OAUTH_CLIENT_UPDATE_BODY = t.Object({
  redirect_uris: t.Optional(t.Array(t.String())),
  token_endpoint_auth_method: t.Optional(t.Union([
    t.Literal("none"),
    t.Literal("client_secret_basic"),
    t.Literal("client_secret_post"),
  ])),
  grant_types: t.Optional(t.Array(t.String())),
  client_name: t.Optional(t.String()),
  client_uri: t.Optional(t.String()),
  logo_uri: t.Optional(t.String()),
});

type OAuthServerSettings = {
  enabled?: boolean;
  allow_dynamic_registration?: boolean;
  issuer?: string;
  migrated_at?: string;
  signing_alg?: string;
  key_id?: string;
  jwt_keys?: unknown;
  jwt_jwks?: unknown;
};

type MigrateOAuthServerInput = {
  allow_dynamic_registration?: boolean;
};

async function loadProjectContext(ref: string) {
  const project = await projectService.getProject(ref);
  if (!project) return null;

  const rows = await metaSql`
    SELECT config, organization_id, jwt_secret
    FROM projects
    WHERE ref = ${ref} AND deleted_at IS NULL
    LIMIT 1
  `;
  const rawConfig = normalizeProjectConfig(rows[0]?.config);
  const routingConfig = normalizeProjectRoutingConfig(rawConfig);
  const apiUrl = resolveProjectApiUrl(ref, routingConfig).replace(/\/+$/, "");
  const serviceRoleKey = await resolveProjectServiceRoleKey(ref);
  const ports = resolveTenantPorts(routingConfig);
  const gotrueUrl = ports?.gotruePort
    ? `http://127.0.0.1:${ports.gotruePort}`
    : apiUrl.replace(/\/+$/, "").replace(/\/auth\/v1$/, "");
  const authConfig = (rawConfig.auth || {}) as Record<string, unknown>;
  const oauthServer = (authConfig.oauth_server || {}) as OAuthServerSettings;

  return {
    project,
    organizationId: rows[0]?.organization_id || project.organization_id || "default",
    jwtSecret: String(rows[0]?.jwt_secret || ""),
    apiUrl,
    issuer: oauthServer.issuer || `${apiUrl}/auth/v1`,
    gotrueUrl,
    serviceRoleKey,
    oauthServer,
  };
}

function buildOAuthServerStatus(ctx: NonNullable<Awaited<ReturnType<typeof loadProjectContext>>>) {
  const issuer = ctx.issuer.replace(/\/+$/, "");
  const apiUrl = ctx.apiUrl.replace(/\/+$/, "");
  const jwtKeys = normalizeProjectJwtKeys(ctx.oauthServer.jwt_keys);
  const jwtJwks = normalizeProjectJwtJwks(ctx.oauthServer.jwt_jwks);
  const migrated = Boolean(jwtKeys && jwtJwks);
  return {
    project_ref: ctx.project.ref,
    organization_id: ctx.organizationId,
    account_isolated: true,
    enabled: migrated && ctx.oauthServer.enabled === true,
    allow_dynamic_registration: ctx.oauthServer.allow_dynamic_registration === true,
    issuer,
    discovery_url: `${issuer}/.well-known/openid-configuration`,
    oauth_authorization_server_metadata_url: `${apiUrl}/.well-known/oauth-authorization-server/auth/v1`,
    jwks_url: `${issuer}/.well-known/jwks.json`,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    userinfo_endpoint: `${issuer}/oauth/userinfo`,
    registration_endpoint: `${issuer}/oauth/clients/register`,
    signing_alg: migrated ? "ES256" : "not_migrated",
    key_id: migrated ? ctx.oauthServer.key_id : undefined,
    oidc_id_token_ready: migrated,
    migration_status: migrated ? "oidc_es256_migrated" : "not_migrated",
    warnings: migrated ? [] : [
      "Project is not migrated to project-scoped OIDC signing keys. Run POST /oauth-server/migrate.",
    ],
  };
}

async function proxyGoTrueAdmin(
  ctx: NonNullable<Awaited<ReturnType<typeof loadProjectContext>>>,
  path: string,
  init: RequestInit = {},
) {
  if (!ctx.serviceRoleKey) {
    return new Response(JSON.stringify({ message: "Project service role key not available", code: "500" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const headers = new Headers(init.headers);
  headers.set("apikey", ctx.serviceRoleKey);
  headers.set("authorization", `Bearer ${ctx.serviceRoleKey}`);
  headers.set("x-project-ref", ctx.project.ref);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  try {
    const upstream = await fetch(`${ctx.gotrueUrl}${path}`, {
      ...init,
      headers,
    });
    const responseHeaders = new Headers();
    const contentType = upstream.headers.get("content-type");
    if (contentType) responseHeaders.set("content-type", contentType);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error: unknown) {
    logger.warn("[auth-oauth-server] GoTrue OAuth admin proxy failed", {
      ref: ctx.project.ref,
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response(JSON.stringify({ message: "GoTrue OAuth admin endpoint unavailable", code: "502" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}

async function migrateProjectToOidc(
  ref: string,
  request: Request,
  input: MigrateOAuthServerInput = {},
) {
  const authError = await requireProjectOrAdminAuth(request, ref);
  if (authError) return status(authError.status, authError.body);
  const ctx = await loadProjectContext(ref);
  if (!ctx) return status(404, { message: "Project not found", code: "404" });

  const settings = await projectService.getProjectSettings(ref);
  if (!settings) return status(404, { message: "Project not found", code: "404" });

  const currentAuth = (settings.auth || {}) as Record<string, unknown>;
  const currentOauthServer = (currentAuth.oauth_server || {}) as OAuthServerSettings;
  const existingJwtKeys = normalizeProjectJwtKeys(currentOauthServer.jwt_keys);
  const existingJwtJwks = normalizeProjectJwtJwks(currentOauthServer.jwt_jwks);
  const keyMaterial = existingJwtKeys && existingJwtJwks && typeof currentOauthServer.key_id === "string"
    ? {
      key_id: currentOauthServer.key_id,
      signing_alg: "ES256" as const,
      jwt_keys: existingJwtKeys,
      jwt_jwks: existingJwtJwks,
    }
    : await generateOidcJwtKeyMaterial(ctx.jwtSecret);

  const oauthServer: OAuthServerSettings = {
    ...currentOauthServer,
    enabled: true,
    allow_dynamic_registration: input.allow_dynamic_registration === true,
    issuer: ctx.issuer,
    migrated_at: new Date().toISOString(),
    signing_alg: keyMaterial.signing_alg,
    key_id: keyMaterial.key_id,
    jwt_keys: keyMaterial.jwt_keys,
    jwt_jwks: keyMaterial.jwt_jwks,
  }

  await projectService.updateProjectSettings(ref, {
    ...settings,
    auth: {
      ...currentAuth,
      oauth_server: oauthServer,
    },
  });

  try {
    await tenantRuntimeService.restartRuntime(ref);
  } catch (error: unknown) {
    logger.warn("[auth-oauth-server] Failed to restart runtime after OAuth/OIDC migration", {
      ref,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const updatedCtx = await loadProjectContext(ref);
  return buildOAuthServerStatus(updatedCtx || ctx);
}

export const authOAuthServerRoutes = new Elysia({ prefix: "/v1/projects/:ref/auth" })
  .get(
    "/oauth-server",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const ctx = await loadProjectContext(params.ref);
      if (!ctx) return status(404, { message: "Project not found", code: "404" });
      return buildOAuthServerStatus(ctx);
    },
    { params: t.Object({ ref: t.String() }), detail: { tags: ["auth"], summary: "Get OAuth server status" } },
  )
  .post(
    "/oauth-server/migrate",
    async ({ params, body, request }) => {
      return migrateProjectToOidc(
        params.ref,
        request,
        body as MigrateOAuthServerInput,
      );
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({ allow_dynamic_registration: t.Optional(t.Boolean()) }),
      detail: { tags: ["auth"], summary: "Migrate project auth to OIDC signing keys" },
    },
  )
  .get(
    "/oauth-clients",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const ctx = await loadProjectContext(params.ref);
      if (!ctx) return status(404, { message: "Project not found", code: "404" });
      return proxyGoTrueAdmin(ctx, "/admin/oauth/clients");
    },
    { params: t.Object({ ref: t.String() }), detail: { tags: ["auth"], summary: "List OAuth clients" } },
  )
  .post(
    "/oauth-clients",
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const ctx = await loadProjectContext(params.ref);
      if (!ctx) return status(404, { message: "Project not found", code: "404" });
      return proxyGoTrueAdmin(ctx, "/admin/oauth/clients", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    { params: t.Object({ ref: t.String() }), body: OAUTH_CLIENT_BODY, detail: { tags: ["auth"], summary: "Create OAuth client" } },
  )
  .get(
    "/oauth-clients/:clientId",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const ctx = await loadProjectContext(params.ref);
      if (!ctx) return status(404, { message: "Project not found", code: "404" });
      return proxyGoTrueAdmin(ctx, `/admin/oauth/clients/${encodeURIComponent(params.clientId)}`);
    },
    { params: t.Object({ ref: t.String(), clientId: t.String() }), detail: { tags: ["auth"], summary: "Get OAuth client" } },
  )
  .put(
    "/oauth-clients/:clientId",
    async ({ params, body, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const ctx = await loadProjectContext(params.ref);
      if (!ctx) return status(404, { message: "Project not found", code: "404" });
      return proxyGoTrueAdmin(ctx, `/admin/oauth/clients/${encodeURIComponent(params.clientId)}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
    },
    { params: t.Object({ ref: t.String(), clientId: t.String() }), body: OAUTH_CLIENT_UPDATE_BODY, detail: { tags: ["auth"], summary: "Update OAuth client" } },
  )
  .delete(
    "/oauth-clients/:clientId",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const ctx = await loadProjectContext(params.ref);
      if (!ctx) return status(404, { message: "Project not found", code: "404" });
      return proxyGoTrueAdmin(ctx, `/admin/oauth/clients/${encodeURIComponent(params.clientId)}`, {
        method: "DELETE",
      });
    },
    { params: t.Object({ ref: t.String(), clientId: t.String() }), detail: { tags: ["auth"], summary: "Delete OAuth client" } },
  )
  .post(
    "/oauth-clients/:clientId/regenerate-secret",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const ctx = await loadProjectContext(params.ref);
      if (!ctx) return status(404, { message: "Project not found", code: "404" });
      return proxyGoTrueAdmin(ctx, `/admin/oauth/clients/${encodeURIComponent(params.clientId)}/regenerate_secret`, {
        method: "POST",
      });
    },
    { params: t.Object({ ref: t.String(), clientId: t.String() }), detail: { tags: ["auth"], summary: "Regenerate OAuth client secret" } },
  );
