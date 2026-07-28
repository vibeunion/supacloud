import { Elysia, t, status } from "elysia";
import { projectService } from "../services";
import { tenantRuntimeService } from "../services/tenant-runtime.service";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { logger } from "../utils/logger";
import { sql as metaSql } from "../db";
import {
  normalizeProjectRoutingConfig,
  resolveProjectAuthUrl,
  resolveProjectApiUrl,
  resolveTenantPorts,
} from "../utils/project-routing";
import { normalizeOAuthServerConfig, normalizeProjectConfig } from "../utils/project-config";
import { requireAuthRuntimeManagement } from "./auth-runtime";
import {
  OAuthAuthorizationPathError,
  resolveOAuthAuthorizationPath,
} from "../utils/oauth-authorization-path";
import {
  buildAwsKmsRs256JwtKeyMaterial,
  generateOidcJwtKeyMaterial,
  normalizeProjectJwtJwks,
  normalizeProjectJwtKeys,
  signOidcServiceRoleJwt,
} from "../utils/project-jwt";
import { buildAuthRuntimeApplyFailureBody } from "./auth-config-responses";

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

function normalizeOAuthClientPayload(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;

  const payload = { ...(input as Record<string, unknown>) };
  const clientType = typeof payload.client_type === "string" ? payload.client_type : "";
  const authMethod = typeof payload.token_endpoint_auth_method === "string"
    ? payload.token_endpoint_auth_method
    : "";
  const isPublicClient = clientType === "public" || authMethod === "none";

  if (clientType === "public" && !authMethod) {
    payload.token_endpoint_auth_method = "none";
  }
  if (isPublicClient && (payload.client_secret === undefined || payload.client_secret === null)) {
    payload.client_secret = "";
  }

  return payload;
}

type OAuthServerSettings = {
  enabled?: boolean;
  allow_dynamic_registration?: boolean;
  issuer?: string;
  migrated_at?: string;
  signing_alg?: string;
  key_id?: string;
  authorization_path?: string;
  jwt_keys?: unknown;
  jwt_jwks?: unknown;
};

type MigrateOAuthServerInput = {
  allow_dynamic_registration?: boolean;
  authorization_path?: string;
};

type KmsRs256Input = {
  aws_kms_arn: string;
  public_jwk: Record<string, unknown>;
  key_id?: string;
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
  const authUrl = resolveProjectAuthUrl(ref, routingConfig).replace(/\/+$/, "");
  const ports = resolveTenantPorts(routingConfig);
  const gotrueUrl = ports?.gotruePort
    ? `http://127.0.0.1:${ports.gotruePort}`
    : apiUrl.replace(/\/+$/, "").replace(/\/auth\/v1$/, "");
  const authConfig = (rawConfig.auth || {}) as Record<string, unknown>;
  const oauthServer = normalizeOAuthServerConfig(authConfig.oauth_server) as OAuthServerSettings;

  return {
    project,
    organizationId: rows[0]?.organization_id || project.organization_id || "default",
    jwtSecret: String(rows[0]?.jwt_secret || ""),
    apiUrl,
    authUrl,
    issuer: oauthServer.issuer || `${authUrl}/auth/v1`,
    gotrueUrl,
    oauthServer,
  };
}

function buildOAuthServerStatus(ctx: NonNullable<Awaited<ReturnType<typeof loadProjectContext>>>) {
  const issuer = ctx.issuer.replace(/\/+$/, "");
  const authUrl = ctx.authUrl.replace(/\/+$/, "");
  const jwtKeys = normalizeProjectJwtKeys(ctx.oauthServer.jwt_keys);
  const jwtJwks = normalizeProjectJwtJwks(ctx.oauthServer.jwt_jwks);
  const migrated = Boolean(jwtKeys && jwtJwks);
  const signingAlg = migrated
    ? String(ctx.oauthServer.signing_alg || jwtKeys?.[0]?.alg || "unknown")
    : "not_migrated";
  return {
    project_ref: ctx.project.ref,
    organization_id: ctx.organizationId,
    account_isolated: true,
    enabled: migrated && ctx.oauthServer.enabled === true,
    allow_dynamic_registration: ctx.oauthServer.allow_dynamic_registration === true,
    issuer,
    authorization_path: ctx.oauthServer.authorization_path,
    discovery_url: `${issuer}/.well-known/openid-configuration`,
    oauth_authorization_server_metadata_url: `${authUrl}/.well-known/oauth-authorization-server/auth/v1`,
    jwks_url: `${issuer}/.well-known/jwks.json`,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    userinfo_endpoint: `${issuer}/oauth/userinfo`,
    registration_endpoint: `${issuer}/oauth/clients/register`,
    signing_alg: signingAlg,
    key_id: migrated ? ctx.oauthServer.key_id : undefined,
    oidc_id_token_ready: migrated,
    migration_status: migrated ? `oidc_${String(signingAlg).toLowerCase()}_migrated` : "not_migrated",
    warnings: migrated ? [] : [
      "Project is not migrated to project-scoped OIDC signing keys. Run POST /oauth-server/migrate.",
    ],
  };
}

async function configureKmsRs256Signing(
  ref: string,
  request: Request,
  input: KmsRs256Input,
) {
  const authError = await requireProjectOrAdminAuth(request, ref);
  if (authError) return status(authError.status, authError.body);
  const ctx = await loadProjectContext(ref);
  if (!ctx) return status(404, { message: "Project not found", code: "404" });

  const settings = await projectService.getProjectSettings(ref);
  if (!settings) return status(404, { message: "Project not found", code: "404" });

  let keyMaterial: Awaited<ReturnType<typeof buildAwsKmsRs256JwtKeyMaterial>>;
  try {
    keyMaterial = await buildAwsKmsRs256JwtKeyMaterial({
      aws_kms_arn: input.aws_kms_arn,
      public_jwk: input.public_jwk,
      key_id: input.key_id,
    });
  } catch (error: unknown) {
    return status(400, {
      message: error instanceof Error ? error.message : "Invalid AWS KMS RS256 signing key",
      code: "400",
    });
  }

  const currentAuth = (settings.auth || {}) as Record<string, unknown>;
  const currentOauthServer = normalizeOAuthServerConfig(currentAuth.oauth_server) as OAuthServerSettings;
  const authorizationPath = resolveOAuthAuthorizationPath(
    undefined,
    currentOauthServer.authorization_path,
  );
  const oauthServer: OAuthServerSettings = {
    ...currentOauthServer,
    enabled: true,
    allow_dynamic_registration: input.allow_dynamic_registration === true,
    issuer: ctx.issuer,
    authorization_path: authorizationPath,
    migrated_at: new Date().toISOString(),
    signing_alg: keyMaterial.signing_alg,
    key_id: keyMaterial.key_id,
    jwt_keys: keyMaterial.jwt_keys,
    jwt_jwks: keyMaterial.jwt_jwks,
  };

  const nextAuth = {
    ...currentAuth,
    oauth_server: oauthServer,
  };
  await projectService.updateProjectSettings(ref, {
    ...settings,
    auth: nextAuth,
  });

  try {
    await tenantRuntimeService.applyAuthConfig(ref, currentAuth, nextAuth);
  } catch (error: unknown) {
    logger.warn("[auth-oauth-server] Failed to apply RS256 KMS signing config", {
      ref,
      error: error instanceof Error ? error.message : String(error),
    });
    return status(503, buildAuthRuntimeApplyFailureBody(ref, error));
  }

  return buildOAuthServerStatus({
    ...ctx,
    oauthServer,
  });
}

async function proxyGoTrueAdmin(
  ctx: NonNullable<Awaited<ReturnType<typeof loadProjectContext>>>,
  path: string,
  init: RequestInit = {},
) {
  const adminToken = await signOidcServiceRoleJwt(ctx.oauthServer.jwt_keys, ctx.issuer);
  if (!adminToken) {
    const signingAlg = String(
      ctx.oauthServer.signing_alg || normalizeProjectJwtKeys(ctx.oauthServer.jwt_keys)?.[0]?.alg || "unknown",
    );
    const message = signingAlg === "RS256"
      ? "Project OAuth admin proxy cannot locally sign RS256/KMS tokens yet. Manage OAuth clients through GoTrue, or configure an ES256 local signing key for the Management API proxy."
      : "Project OAuth ES256 signing key not available. Re-apply OAuth server migration before managing OAuth clients.";
    return new Response(JSON.stringify({
      message,
      code: "409",
    }), {
      status: 409,
      headers: { "content-type": "application/json" },
    });
  }

  const headers = new Headers(init.headers);
  headers.set("apikey", adminToken);
  headers.set("authorization", `Bearer ${adminToken}`);
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
  const currentOauthServer = normalizeOAuthServerConfig(currentAuth.oauth_server) as OAuthServerSettings;
  let authorizationPath: string;
  try {
    authorizationPath = resolveOAuthAuthorizationPath(
      input.authorization_path,
      currentOauthServer.authorization_path,
    );
  } catch (error: unknown) {
    if (error instanceof OAuthAuthorizationPathError) {
      return status(400, { message: error.message, code: "400" });
    }
    throw error;
  }
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
    authorization_path: authorizationPath,
    migrated_at: new Date().toISOString(),
    signing_alg: keyMaterial.signing_alg,
    key_id: keyMaterial.key_id,
    jwt_keys: keyMaterial.jwt_keys,
    jwt_jwks: keyMaterial.jwt_jwks,
  }

  const nextAuth = {
    ...currentAuth,
    oauth_server: oauthServer,
  };
  await projectService.updateProjectSettings(ref, {
    ...settings,
    auth: nextAuth,
  });

  try {
    await tenantRuntimeService.applyAuthConfig(ref, currentAuth, nextAuth);
  } catch (error: unknown) {
    logger.warn("[auth-oauth-server] Failed to apply OAuth/OIDC migration", {
      ref,
      error: error instanceof Error ? error.message : String(error),
    });
    return status(503, buildAuthRuntimeApplyFailureBody(ref, error));
  }

  return buildOAuthServerStatus({ ...ctx, oauthServer });
}

export const authOAuthServerRoutes = new Elysia({ prefix: "/v1/projects/:ref/auth" })
  .onBeforeHandle(requireAuthRuntimeManagement("oauth"))
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
      body: t.Object({
        allow_dynamic_registration: t.Optional(t.Boolean()),
        authorization_path: t.Optional(t.String({ minLength: 1, maxLength: 2048 })),
      }),
      detail: { tags: ["auth"], summary: "Migrate project auth to OIDC signing keys" },
    },
  )

  .post(
    "/oauth-server/kms-rs256",
    async ({ params, body, request }) => {
      return configureKmsRs256Signing(params.ref, request, body as KmsRs256Input);
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        aws_kms_arn: t.String(),
        public_jwk: t.Record(t.String(), t.Unknown()),
        key_id: t.Optional(t.String()),
        allow_dynamic_registration: t.Optional(t.Boolean()),
      }),
      detail: { tags: ["auth"], summary: "Configure RS256 JWT signing backed by AWS KMS" },
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
        body: JSON.stringify(normalizeOAuthClientPayload(body)),
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
        body: JSON.stringify(normalizeOAuthClientPayload(body)),
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
