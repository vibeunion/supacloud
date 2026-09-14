import { Elysia, t, status } from "elysia";
import { isDeepStrictEqual } from "node:util";
import { projectService } from "../services";
import { tenantRuntimeService } from "../services/tenant-runtime.service";
import { requireProjectOrAdminAuth } from "../middleware/auth";
import { logger } from "../utils/logger";
import { projectAuthRepository } from "../repositories/project-auth.repository";
import {
  normalizeProjectRoutingConfig,
  resolveProjectAuthUrl,
  resolveProjectApiUrl,
  resolveTenantPorts,
} from "../utils/project-routing";
import {
  parseOAuthServerSettings, parseProjectAuthConfig, ProjectAuthContextError,
  type OAuthServerSettings,
} from "../utils/project-auth-record";
import { requireAuthRuntimeManagement } from "./auth-runtime";
import { getAuthRuntimeDescriptor } from "../services/auth-runtime.service";
import { resolveAuthExecutionPolicy } from "../services/auth-execution-policy";
import { buildProjectJwtSettings, canonicalJwtIssuerUrl } from "../services/project-jwt-settings";
import {
  OAuthAuthorizationPathError,
  resolveOAuthAuthorizationPath,
  validateOAuthAuthorizationPath,
} from "../utils/oauth-authorization-path";
import {
  buildAwsKmsRs256JwtKeyMaterial,
  generateOidcJwtKeyMaterial,
  normalizeProjectJwtJwks,
  normalizeProjectJwtKeys,
  signOidcServiceRoleJwt,
  type OidcJwtKeyMaterial,
} from "../utils/project-jwt";
import { buildAuthRuntimeApplyFailureBody } from "./auth-config-responses";
import { GoTrueOAuthError, requestGoTrueOAuth, type GoTrueOAuthOperation } from "../services/gotrue-oauth-admin";

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

class ExternalOAuthManagementError extends Error {}

async function readProjectContext(ref: string) {
  const project = await projectAuthRepository.findByRef(ref);
  if (!project) return null;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(ref) || project.ref !== ref) throw new ProjectAuthContextError();
  const rawConfig = project.config;
  const runtime = getAuthRuntimeDescriptor(ref);
  const executionPolicy = resolveAuthExecutionPolicy(runtime, rawConfig);
  if (!executionPolicy.localGoTrue) throw new ExternalOAuthManagementError();
  const routingConfig = normalizeProjectRoutingConfig(rawConfig);
  let apiUrl: string;
  let authUrl: string;
  try {
    apiUrl = canonicalJwtIssuerUrl(resolveProjectApiUrl(ref, routingConfig));
    authUrl = canonicalJwtIssuerUrl(resolveProjectAuthUrl(ref, routingConfig));
  } catch { throw new ProjectAuthContextError(); }
  const ports = resolveTenantPorts(routingConfig);
  const gotrueUrl = ports?.gotruePort
    ? `http://127.0.0.1:${ports.gotruePort}`
    : apiUrl.replace(/\/+$/, "").replace(/\/auth\/v1$/, "");
  const authConfig = parseProjectAuthConfig(rawConfig.auth);
  const oauthServer = parseOAuthServerSettings(authConfig.oauth_server);

  return {
    project, runtime, authConfig,
    organizationId: project.organization_id,
    jwtSecret: project.jwt_secret,
    apiUrl,
    authUrl,
    issuer: oauthServer.issuer || `${authUrl}/auth/v1`,
    gotrueUrl,
    oauthServer,
  };
}

async function loadProjectContext(ref: string) {
  try {
    return await readProjectContext(ref);
  } catch (error) {
    if (error instanceof ExternalOAuthManagementError) throw error;
    throw new ProjectAuthContextError();
  }
}

type OAuthContext = NonNullable<Awaited<ReturnType<typeof loadProjectContext>>>;

export interface OAuthServerStatus {
  project_ref: string;
  organization_id: string | null;
  account_isolated: true;
  enabled: boolean;
  state_source: "configuration";
  runtime_verified: false;
  allow_dynamic_registration: boolean;
  issuer: string;
  authorization_path: string;
  discovery_url: string;
  oauth_authorization_server_metadata_url: string;
  jwks_url: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  registration_endpoint: string;
  signing_alg: "ES256" | "RS256" | "not_migrated";
  key_id?: string;
  oidc_id_token_ready: boolean;
  migration_status: "oidc_es256_migrated" | "oidc_rs256_migrated" | "not_migrated";
  warnings: string[];
}

async function buildOAuthServerStatus(ctx: OAuthContext): Promise<OAuthServerStatus> {
  let jwt: Awaited<ReturnType<typeof buildProjectJwtSettings>>;
  let authorizationPath: string;
  try {
    jwt = await buildProjectJwtSettings(ctx.project.ref, {
      ...ctx.project.config, auth: { ...ctx.authConfig, oauth_server: ctx.oauthServer },
    }, ctx.runtime);
    authorizationPath = ctx.oauthServer.authorization_path === undefined
      ? resolveOAuthAuthorizationPath(undefined, undefined)
      : validateOAuthAuthorizationPath(ctx.oauthServer.authorization_path);
  } catch { throw new ProjectAuthContextError(); }
  if (jwt.execution_mode === "shared" || jwt.execution_mode === "external") throw new ExternalOAuthManagementError();
  const { signing } = jwt;
  const issuer = signing.issuer;
  const authUrl = ctx.authUrl;
  const migrated = signing.migration_status === "configured";
  const signingAlg = signing.algorithm ?? "not_migrated";
  return {
    project_ref: ctx.project.ref,
    organization_id: ctx.organizationId,
    account_isolated: true,
    enabled: signing.oauth_enabled,
    state_source: "configuration" as const,
    runtime_verified: false as const,
    allow_dynamic_registration: ctx.oauthServer.allow_dynamic_registration === true,
    issuer,
    authorization_path: authorizationPath,
    discovery_url: `${issuer}/.well-known/openid-configuration`,
    oauth_authorization_server_metadata_url: `${authUrl}/.well-known/oauth-authorization-server/auth/v1`,
    jwks_url: `${issuer}/.well-known/jwks.json`,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    userinfo_endpoint: `${issuer}/oauth/userinfo`,
    registration_endpoint: `${issuer}/oauth/clients/register`,
    signing_alg: signingAlg,
    ...(signing.key_id === null ? {} : { key_id: signing.key_id }),
    oidc_id_token_ready: migrated,
    migration_status: signing.algorithm === "ES256" ? "oidc_es256_migrated"
      : signing.algorithm === "RS256" ? "oidc_rs256_migrated" : "not_migrated",
    warnings: migrated ? [] : [
      "Project is not migrated to project-scoped OIDC signing keys. Run POST /oauth-server/migrate.",
    ],
  };
}

async function currentContext(ctx: OAuthContext, expectedAuth: Record<string, unknown> = ctx.authConfig): Promise<OAuthContext> {
  const current = await loadProjectContext(ctx.project.ref);
  if (!current || !isDeepStrictEqual(current.runtime, ctx.runtime)
    || !isDeepStrictEqual(current.authConfig, expectedAuth)
    || current.apiUrl !== ctx.apiUrl || current.authUrl !== ctx.authUrl
    || current.gotrueUrl !== ctx.gotrueUrl || current.jwtSecret !== ctx.jwtSecret
    || current.organizationId !== ctx.organizationId) throw new ProjectAuthContextError();
  return current;
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
      ...(input.key_id === undefined ? {} : { key_id: input.key_id }),
    });
  } catch (error: unknown) {
    return status(400, {
      message: error instanceof Error ? error.message : "Invalid AWS KMS RS256 signing key",
      code: "400",
    });
  }

  const currentAuth = parseProjectAuthConfig(settings.auth);
  const currentOauthServer = parseOAuthServerSettings(currentAuth.oauth_server);
  let authorizationPath: string;
  try {
    authorizationPath = currentOauthServer.authorization_path === undefined
      ? resolveOAuthAuthorizationPath(undefined, undefined)
      : validateOAuthAuthorizationPath(currentOauthServer.authorization_path);
  } catch { throw new ProjectAuthContextError(); }
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
  const nextStatus = await buildOAuthServerStatus({ ...ctx, authConfig: nextAuth, oauthServer });
  await currentContext(ctx, currentAuth);
  const persisted = await projectService.updateProjectSettings(ref, {
    ...settings,
    auth: nextAuth,
  });
  if (!persisted) return status(404, { message: "Project not found", code: "404" });
  await currentContext(ctx, nextAuth);

  try {
    await tenantRuntimeService.applyAuthConfig(ref, currentAuth, nextAuth);
  } catch (error: unknown) {
    logger.warn("[auth-oauth-server] Failed to apply RS256 KMS signing config", {
      ref,
      error: error instanceof Error ? error.message : String(error),
    });
    return status(503, buildAuthRuntimeApplyFailureBody(ref, error));
  }

  await currentContext(ctx, nextAuth);
  return nextStatus;
}

async function proxyGoTrueAdmin(
  ctx: OAuthContext,
  operation: GoTrueOAuthOperation,
  request: Request,
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

  await buildOAuthServerStatus(ctx);
  await currentContext(ctx);
  try {
    const response = await requestGoTrueOAuth({
      url: ctx.gotrueUrl, projectRef: ctx.project.ref, adminToken, signal: request.signal,
    }, operation);
    try { await currentContext(ctx); }
    catch (error) {
      void response.body?.cancel().catch(() => {});
      if (operation.kind !== "list" && operation.kind !== "get") {
        return Response.json({
          code: "OAUTH_CONTEXT_UNCONFIRMED", message: "OAuth client result cannot be confirmed against current project context",
          mutation_may_have_applied: true,
        }, { status: 503 });
      }
      throw error;
    }
    return response;
  } catch (error: unknown) {
    if (error instanceof ProjectAuthContextError || error instanceof ExternalOAuthManagementError) throw error;
    const failure = error instanceof GoTrueOAuthError ? error : new GoTrueOAuthError();
    logger.warn("[auth-oauth-server] GoTrue OAuth admin request failed", {
      ref: ctx.project.ref, operation: operation.kind, status: failure.status,
    });
    return Response.json({
      message: failure.message, code: String(failure.status),
      ...(failure.mutationMayHaveApplied ? { mutation_may_have_applied: true } : {}),
    }, {
      status: failure.status,
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

  const currentAuth = parseProjectAuthConfig(settings.auth);
  const currentOauthServer = parseOAuthServerSettings(currentAuth.oauth_server);
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
  const currentStatus = await buildOAuthServerStatus({ ...ctx, authConfig: currentAuth, oauthServer: currentOauthServer });
  let keyMaterial: OidcJwtKeyMaterial;
  if (currentStatus.signing_alg === "not_migrated") {
    keyMaterial = await generateOidcJwtKeyMaterial(ctx.jwtSecret);
  } else {
    const keys = normalizeProjectJwtKeys(currentOauthServer.jwt_keys);
    const jwks = normalizeProjectJwtJwks(currentOauthServer.jwt_jwks);
    if (!keys || !jwks || !currentStatus.key_id) throw new ProjectAuthContextError();
    keyMaterial = { key_id: currentStatus.key_id, signing_alg: currentStatus.signing_alg, jwt_keys: keys, jwt_jwks: jwks };
  }

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
  const nextStatus = await buildOAuthServerStatus({ ...ctx, authConfig: nextAuth, oauthServer });
  await currentContext(ctx, currentAuth);
  const persisted = await projectService.updateProjectSettings(ref, {
    ...settings,
    auth: nextAuth,
  });
  if (!persisted) return status(404, { message: "Project not found", code: "404" });
  await currentContext(ctx, nextAuth);

  try {
    await tenantRuntimeService.applyAuthConfig(ref, currentAuth, nextAuth);
  } catch (error: unknown) {
    logger.warn("[auth-oauth-server] Failed to apply OAuth/OIDC migration", {
      ref,
      error: error instanceof Error ? error.message : String(error),
    });
    return status(503, buildAuthRuntimeApplyFailureBody(ref, error));
  }

  await currentContext(ctx, nextAuth);
  return nextStatus;
}

export const authOAuthServerRoutes = new Elysia({ prefix: "/v1/projects/:ref/auth" })
  .onRequest(({ set }) => { set.headers["cache-control"] = "no-store"; })
  .onError(({ error }) => {
    if (error instanceof ExternalOAuthManagementError) {
      return Response.json({
        code: "AUTH_RUNTIME_NOT_LOCAL", message: "OAuth management is not available for a non-local Auth runtime",
      }, { status: 409, headers: { "cache-control": "no-store" } });
    }
    if (error instanceof ProjectAuthContextError) {
      return Response.json(error.toJSON(), { status: 503, headers: { "cache-control": "no-store" } });
    }
  })
  .onBeforeHandle(requireAuthRuntimeManagement("oauth"))
  .get(
    "/oauth-server",
    async ({ params, request }) => {
      const authError = await requireProjectOrAdminAuth(request, params.ref);
      if (authError) return status(authError.status, authError.body);
      const ctx = await loadProjectContext(params.ref);
      if (!ctx) return status(404, { message: "Project not found", code: "404" });
      const result = await buildOAuthServerStatus(ctx);
      await currentContext(ctx);
      return result;
    },
    { params: t.Object({ ref: t.String() }), detail: { tags: ["auth"], summary: "Get OAuth server status" } },
  )
  .post(
    "/oauth-server/migrate",
    async ({ params, body, request }) => {
      return migrateProjectToOidc(
        params.ref,
        request,
        body,
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
      return configureKmsRs256Signing(params.ref, request, body);
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
      return proxyGoTrueAdmin(ctx, { kind: "list" }, request);
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
      return proxyGoTrueAdmin(ctx, { kind: "create", input: body }, request);
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
      return proxyGoTrueAdmin(ctx, { kind: "get", clientId: params.clientId }, request);
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
      return proxyGoTrueAdmin(ctx, { kind: "update", clientId: params.clientId, input: body }, request);
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
      return proxyGoTrueAdmin(ctx, { kind: "delete", clientId: params.clientId }, request);
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
      return proxyGoTrueAdmin(ctx, { kind: "regenerate", clientId: params.clientId }, request);
    },
    { params: t.Object({ ref: t.String(), clientId: t.String() }), detail: { tags: ["auth"], summary: "Regenerate OAuth client secret" } },
  );
