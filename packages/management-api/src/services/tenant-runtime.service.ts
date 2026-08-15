import { $ } from "bun";
import { logger } from "../utils/logger";
import { config } from "../config";
import { sql as metaSql, resolveDbName, resolveAuthenticatorName, resolvePgrstChannel, resolveRoleName } from "../db";
import { SQL_MODULES } from "../db/sql-modules";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { OAuthProvider, OAuthProviderConfig } from "../types/oauth";
import { OAUTH_ENV_MAPPINGS } from "../types/oauth";
import { tenantOAuthService } from "./tenant-oauth.service";
import { resolveProjectApiUrl, resolveProjectAuthUrl, resolveProjectStudioUrl } from "../utils/project-routing";
import {
    normalizeOAuthServerConfig,
    normalizeProjectConfig,
    resolveProjectExternalAuthEndpointConfig,
} from "../utils/project-config";
import {
    buildSharedProjectJwtVerificationMaterial,
    normalizeProjectJwtKeys,
    resolveProjectJwtVerificationMaterial,
    type ThirdPartyJwtPolicy,
} from "../utils/project-jwt";
import { uniqueStrings } from "../utils/strings";
import { ALTER_TENANT_SQL } from "./tenant-runtime-migration";
import {
    assertSafeConfigValue,
    buildPostgresUri,
    buildTenantPsqlInvocation,
    pickPositivePort,
    quoteTomlBasicString,
    renderGoTrueAuthEnv,
    renderGoTrueProviderLinkingEnv,
    renderGoTruePasskeyEnv,
    renderGoTrueSamlEnv,
    renderGoTrueSessionPolicyEnv,
    renderPostgrestDbSchemas,
    renderSystemdEnvLine,
    renderTenantInternalRuntimeEnv,
    stringifyJsonConfig,
} from "./tenant-runtime-config";
import type { PostgresConnectionConfig } from "./tenant-runtime-config";
import { decryptSecretIfNeeded } from "../utils/secret-crypto";
import {
    getAuthRuntimeDescriptor,
    isSharedAuthRuntime,
    type AuthRuntimeMode,
} from "./auth-runtime.service";
import { authConfigChangesPostgrestVerifier } from "./auth-runtime-impact";
import { runtimeCacheService } from "./runtime-cache.service";
import { projectControlSecretsService } from "./project-control-secrets.service";
import { installManagedSystemdUnit } from "./systemd-unit-broker";
import { renderPostgrestSystemdTemplate } from "./postgrest-systemd-template";
import {
    PostgrestPoolReconcileError,
    PostgrestPoolMigrationGate,
    reconcileManagedPostgrestPool,
    type PostgrestPoolGeneration,
    type PostgrestPoolReconcileOperations,
    type PostgrestPoolReconcileResult,
} from "./postgrest-pool-reconcile";
import {
    activatePostgrestGeneration,
    postgrestGenerationLayout,
    readPostgrestPointerTarget,
    removePostgrestPointerIfCurrent,
    replacePostgrestPointer,
    validatePostgrestGenerationTarget,
    type ActivatedPostgrestGeneration,
    type PostgrestControlOwnership,
} from "./postgrest-generation";
import { completePostgrestActivation } from "./postgrest-activation";
import {
    attestPostgrestRuntime,
    type PostgrestAttestation,
} from "./postgrest-runtime-attestation";
import {
    canonicalPostgrestConfig,
    postgrestConfigRevision,
} from "./runtime-revision";

export {
    renderGoTrueAuthEnv,
    renderGoTruePasskeyEnv,
    renderGoTrueSamlEnv,
    renderGoTrueSessionPolicyEnv,
    renderPostgrestDbSchemas,
    renderTenantInternalRuntimeEnv,
} from "./tenant-runtime-config";

export function isGoTruePasskeyVersionSupported(version: string): boolean {
    const match = version.trim().match(/^v(\d+)\.(\d+)\.(\d+)(?:[-+][A-Za-z0-9._-]+)?$/);
    if (!match) return false;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    return major === 2 && minor >= 194;
}

export class SupAuthDependentRefreshError extends Error {
    readonly code = "SUPAUTH_DEPENDENT_REFRESH_FAILED";

    constructor(
        readonly failedRefs: string[],
        options: { cause?: unknown } = {},
    ) {
        super(
            failedRefs.length > 0
                ? `Failed to refresh SupAuth dependents: ${failedRefs.join(", ")}`
                : "Failed to enumerate SupAuth dependents",
            options.cause === undefined ? undefined : { cause: options.cause },
        );
        this.name = "SupAuthDependentRefreshError";
    }
}

type SystemctlAction = "daemon-reload" | "disable" | "enable" | "reset-failed" | "restart" | "start" | "stop";
type SystemctlExecutionMode = "best-effort" | "checked";
type PostgrestActivationMode = "ensure-running" | "restart-running" | "refresh-if-running";
type PostgrestPoolContext = {
    ref: string;
    runtimeUser: string;
    ownership: PostgrestControlOwnership;
};
type RenderedPostgrestGenerationRequest = {
    ref: string;
    content: string;
    runtimeUser: string;
    runtimeGroupGid: number;
    expectedPreviousPointerTarget?: string;
};
type AuthoritativePostgrestDesired = {
    revision: string;
    desired: RuntimeDesiredState;
    port: number;
};

function recordValue(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
    return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function firstDefinedString(...values: unknown[]): string | undefined {
    return values.find((value): value is string => typeof value === "string");
}

export function resolveTenantAuthUrlSettings(ref: string, projectConfig: Record<string, unknown>) {
    const authConfig = recordValue(projectConfig.auth);
    const legacyRedirectUrls = Array.isArray(projectConfig.additional_redirect_urls)
        ? projectConfig.additional_redirect_urls.join(",")
        : (Array.isArray(projectConfig.additionalRedirectUrls)
            ? projectConfig.additionalRedirectUrls.join(",")
            : "");
    return {
        authConfig,
        siteUrl: firstNonEmptyString(
            authConfig.site_url,
            authConfig.SITE_URL,
            projectConfig.site_url,
            projectConfig.siteUrl,
        ) || resolveProjectStudioUrl(ref, projectConfig),
        uriAllowList: firstDefinedString(
            authConfig.uri_allow_list,
            authConfig.URI_ALLOW_LIST,
        ) ?? legacyRedirectUrls,
    };
}

async function renderConnectorSecretEnv(
    ref: string,
    authConfig: Record<string, unknown>,
): Promise<string[]> {
    const lines: string[] = [];
    const external = recordValue(authConfig.external);
    for (const [providerName, rawConfig] of Object.entries(external)) {
        const providerConfig = recordValue(rawConfig);
        const mapping = OAUTH_ENV_MAPPINGS[providerName as OAuthProvider];
        const clientId = typeof providerConfig.client_id === "string" ? providerConfig.client_id : "";
        if (!mapping || !clientId) continue;
        const clientSecret = await projectControlSecretsService.readRequiredValue(
            ref,
            "connector",
            providerName,
        );

        lines.push(
            `GOTRUE_EXTERNAL_${providerName.toUpperCase()}_ENABLED=true`,
            renderSystemdEnvLine(mapping.clientId, clientId),
            renderSystemdEnvLine(mapping.clientSecret, clientSecret),
        );
        if (mapping.redirectUri && typeof providerConfig.redirect_uri === "string") {
            lines.push(renderSystemdEnvLine(mapping.redirectUri, providerConfig.redirect_uri));
        }
        if (mapping.url && typeof providerConfig.url === "string") {
            lines.push(renderSystemdEnvLine(mapping.url, providerConfig.url));
        }
    }

    return lines;
}

async function renderCaptchaSecretEnv(
    ref: string,
    authConfig: Record<string, unknown>,
): Promise<string[]> {
    const captchaEnabled = authConfig.security_captcha_enabled === true;
    if (!captchaEnabled) return [];

    const captchaProvider = typeof authConfig.security_captcha_provider === "string"
        ? authConfig.security_captcha_provider.toLowerCase()
        : "default";
    const captchaSecret = await projectControlSecretsService.readRequiredValue(
        ref,
        "captcha",
        captchaProvider,
    );
    return [
        "GOTRUE_SECURITY_CAPTCHA_ENABLED=true",
        renderSystemdEnvLine("GOTRUE_SECURITY_CAPTCHA_PROVIDER", captchaProvider),
        renderSystemdEnvLine("GOTRUE_SECURITY_CAPTCHA_SECRET", captchaSecret),
    ];
}

async function renderHookSecretEnv(
    ref: string,
    authConfig: Record<string, unknown>,
): Promise<string[]> {
    const lines: string[] = [];
    const hookPrefixes: Record<string, string> = {
        custom_access_token_hook: "CUSTOM_ACCESS_TOKEN",
        mfa_verification_hook: "MFA_VERIFICATION_ATTEMPT",
        password_verification_hook: "PASSWORD_VERIFICATION_ATTEMPT",
        send_sms_hook: "SEND_SMS",
        send_email_hook: "SEND_EMAIL",
        before_user_created_hook: "BEFORE_USER_CREATED",
    };
    const hooks = recordValue(authConfig.hooks);
    for (const [hookName, prefix] of Object.entries(hookPrefixes)) {
        const hook = recordValue(hooks[hookName]);
        if (hook.enabled !== true || typeof hook.uri !== "string" || !hook.uri) continue;
        const secret = await projectControlSecretsService.readRequiredValue(ref, "auth-hook", hookName);
        lines.push(
            `GOTRUE_HOOK_${prefix}_ENABLED=true`,
            renderSystemdEnvLine(`GOTRUE_HOOK_${prefix}_URI`, hook.uri),
            renderSystemdEnvLine(`GOTRUE_HOOK_${prefix}_SECRETS`, secret),
        );
    }
    return lines;
}

export async function renderManagedGoTrueSecretEnv(
    ref: string,
    authConfig: Record<string, unknown>,
): Promise<string[]> {
    const connectorLines = await renderConnectorSecretEnv(ref, authConfig);
    const captchaLines = await renderCaptchaSecretEnv(ref, authConfig);
    const hookLines = await renderHookSecretEnv(ref, authConfig);
    return [...connectorLines, ...captchaLines, ...hookLines];
}

async function runSystemctlOrThrow(action: SystemctlAction, unit?: string): Promise<void> {
    const result = unit
        ? await $`systemctl ${action} ${unit}`.nothrow().quiet()
        : await $`systemctl ${action}`.nothrow().quiet();
    if (result.exitCode === 0) return;

    const detail = result.stderr.toString().trim()
        || result.stdout.toString().trim()
        || `exit code ${result.exitCode}`;
    throw new Error(`systemctl ${action}${unit ? ` ${unit}` : ""} failed: ${detail.slice(0, 300)}`);
}

function quoteSqlLiteral(value: string): string {
    assertSafeConfigValue("PostgreSQL literal", value);
    return `'${value.replace(/'/g, "''")}'`;
}

export interface RuntimeStatus {
    status: "running" | "stopped" | "starting" | "error";
    port: number;
    gotruePort: number;
    health: "healthy" | "degraded" | "unhealthy" | "unknown";
}

export type RuntimeDesiredState = "running" | "stopped";

export interface PostgrestRuntimeStatus {
    component: "postgrest";
    desired: RuntimeDesiredState;
    actual: RuntimeStatus["status"];
    port: number;
    unit: string;
    health: "healthy" | "unhealthy" | "unknown";
    last_error: string | null;
    updated_at: string | null;
    last_reconciled_at: string | null;
}

export interface PostgrestRuntimeSnapshot extends Omit<PostgrestAttestation, "desiredRevision"> {
    desiredRevision: string;
    desired: RuntimeDesiredState;
    port: number;
    unit: string;
}

export interface ProjectServiceStatus {
    id: string;
    name: string;
    status: string;
    healthy: boolean;
    service_host_ids: string[];
    component?: "postgrest";
    desired_state?: RuntimeDesiredState;
    actual_state?: RuntimeStatus["status"];
    health?: PostgrestRuntimeStatus["health"];
    port?: number;
    unit?: string;
    last_error?: string | null;
    updated_at?: string | null;
    last_reconciled_at?: string | null;
    runtime_mode?: AuthRuntimeMode | "external";
    managed_by_ref?: string;
    local_runtime_enabled?: boolean;
}

type AuthServiceRuntimeDescriptor = Pick<
    ReturnType<typeof getAuthRuntimeDescriptor>,
    "project_ref" | "mode" | "authority_project_ref" | "local_gotrue_enabled"
>;

export function projectAuthServiceEntry(
    rawAuth: ProjectServiceStatus,
    authRuntime: AuthServiceRuntimeDescriptor,
    projectConfig: unknown,
): ProjectServiceStatus {
    const externalAuth = authRuntime.mode === "local"
        ? resolveProjectExternalAuthEndpointConfig(projectConfig)
        : null;
    const status = externalAuth && rawAuth.status === "UNHEALTHY" ? "INACTIVE" : rawAuth.status;
    return {
        ...rawAuth,
        status,
        healthy: status === "ACTIVE_HEALTHY",
        service_host_ids: [`${authRuntime.authority_project_ref}-${rawAuth.id}`],
        unit: `supacloud-gotrue@${authRuntime.authority_project_ref}`,
        runtime_mode: externalAuth ? "external" : authRuntime.mode,
        managed_by_ref: authRuntime.mode === "local" ? undefined : authRuntime.authority_project_ref,
        local_runtime_enabled: externalAuth ? false : authRuntime.local_gotrue_enabled,
    };
}

interface DesiredPostgrestConfigRequest {
    projectRef: string;
    databaseUri: string;
    databaseSchemas: string;
    jwtVerifierSecret: string;
    jwtAudience: string;
    port: number;
    databasePool: number;
    apiUrl: string;
}

interface PostgrestCredentialMaterial {
    dbPassword: string;
    jwtSecret: string;
    jwtJwks: string | null;
    thirdPartyJwtPolicy: ThirdPartyJwtPolicy | null;
    dbName: string;
    apiUrl: string;
}

export function renderDesiredPostgrestConfig(
    request: DesiredPostgrestConfigRequest,
): string {
    const jwtAudience = request.jwtAudience
        ? `jwt-aud = ${quoteTomlBasicString(request.jwtAudience)}`
        : "";
    return `
# Managed by SupaCloud Management API. Legacy shell tooling must not overwrite this file.
# PostgREST config for tenant: ${request.projectRef}
db-uri = ${quoteTomlBasicString(request.databaseUri)}
db-schemas = ${quoteTomlBasicString(request.databaseSchemas)}
db-extra-search-path = "public, extensions, auth"
db-anon-role = "anon"
jwt-secret = ${quoteTomlBasicString(request.jwtVerifierSecret)}
${jwtAudience}
server-port = ${request.port}
server-host = "0.0.0.0"
db-pool = ${request.databasePool}
db-pool-acquisition-timeout = 10
log-level = "warn"

# P0-10: OpenAPI spec generation (required by Studio Table Editor & API Docs)
openapi-mode = "follow-privileges"
openapi-server-proxy-uri = ${quoteTomlBasicString(`${request.apiUrl}/rest/v1`)}

# P0-11: Pre-request function for RLS context injection
db-pre-request = "public.set_request_context"

# P1-7: Row limit protection
db-max-rows = 1000

# P2-3: Restrict CORS to the tenant's API domain
server-cors-allowed-origins = ${quoteTomlBasicString(request.apiUrl)}

# P2-4: Tenant-specific listen channel for schema cache invalidation
db-channel = ${quoteTomlBasicString(resolvePgrstChannel(request.projectRef))}
`.trim();
}

const POSTGREST_HEALTH_PATHS = ["/"] as const;

export async function probePostgrestHealth(
    port: number,
    fetcher: typeof fetch = fetch,
): Promise<{ healthy: boolean; last_error: string | null }> {
    const failures: string[] = [];

    for (const path of POSTGREST_HEALTH_PATHS) {
        try {
            const res = await fetcher(`http://127.0.0.1:${port}${path}`);
            if (res.status < 500) {
                return { healthy: true, last_error: null };
            }
            failures.push(`${path} HTTP ${res.status}`);
        } catch (error: unknown) {
            failures.push(`${path} ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return {
        healthy: false,
        last_error: `PostgREST health checks failed: ${failures.join("; ")}`,
    };
}

export function parsePostgrestActivity(output: string, exitCode: number): boolean {
    const activity = output.trim();
    if (exitCode === 0 && activity === "active") return true;
    if (exitCode === 3 && (activity === "inactive" || activity === "failed")) return false;
    throw new Error("Unable to determine PostgREST systemd activity");
}

class PostgrestRuntimeController {
    unit(ref: string): string {
        return `supacloud-pgrst@${ref}`;
    }

    async isActive(ref: string): Promise<boolean> {
        const child = Bun.spawn({
            cmd: ["systemctl", "is-active", this.unit(ref)],
            stdout: "pipe",
            stderr: "ignore",
        });
        const [stdout, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            child.exited,
        ]);
        return parsePostgrestActivity(stdout, exitCode);
    }

    async enable(ref: string): Promise<void> {
        await runSystemctlOrThrow("enable", this.unit(ref));
    }

    async start(ref: string): Promise<void> {
        await runSystemctlOrThrow("start", this.unit(ref));
    }

    async restart(ref: string): Promise<void> {
        await runSystemctlOrThrow("restart", this.unit(ref));
    }

    async stop(ref: string): Promise<void> {
        await runSystemctlOrThrow("stop", this.unit(ref));
    }

    async disable(ref: string): Promise<void> {
        await runSystemctlOrThrow("disable", this.unit(ref));
    }

    async observe(ref: string, port: number): Promise<Pick<PostgrestRuntimeStatus, "actual" | "health" | "last_error">> {
        if (!(await this.isActive(ref))) {
            return { actual: "stopped", health: "unknown", last_error: null };
        }

        const probe = await probePostgrestHealth(port);
        if (probe.healthy) {
            return { actual: "running", health: "healthy", last_error: null };
        }

        return {
            actual: "error",
            health: "unhealthy",
            last_error: probe.last_error,
        };
    }

    async waitForHealthy(
        ref: string,
        port: number,
        attempts = 10,
        delayMs = 500,
    ): Promise<PostgrestRuntimeStatus> {
        let status = await this.observe(ref, port);
        for (let tryIdx = 0; tryIdx < attempts && status.health !== "healthy"; tryIdx++) {
            await Bun.sleep(delayMs);
            status = await this.observe(ref, port);
        }
        return {
            component: "postgrest",
            desired: "running",
            actual: status.actual,
            port,
            unit: this.unit(ref),
            health: status.health,
            last_error: status.last_error,
            updated_at: null,
            last_reconciled_at: null,
        };
    }

    async stopAndDisable(ref: string): Promise<void> {
        await this.stop(ref);
        await this.disable(ref);
    }
}

export interface GotrueRuntimeStatus {
    component: "gotrue";
    desired: RuntimeDesiredState;
    actual: RuntimeStatus["status"];
    port: number;
    unit: string;
    health: "healthy" | "unhealthy" | "unknown";
    last_error: string | null;
    updated_at: string | null;
    last_reconciled_at: string | null;
}

type AppliedGotrueAuthConfig = {
    authRuntime: ReturnType<typeof getAuthRuntimeDescriptor>;
    status: GotrueRuntimeStatus;
};

class GotrueRuntimeController {
    unit(ref: string): string {
        return `supacloud-gotrue@${ref}`;
    }

    async isActive(ref: string): Promise<boolean> {
        return (await $`systemctl is-active ${this.unit(ref)}`.nothrow().quiet()).exitCode === 0;
    }

    async isFailed(ref: string): Promise<boolean> {
        return (await $`systemctl is-failed ${this.unit(ref)}`.nothrow().quiet()).exitCode === 0;
    }

    async enable(ref: string): Promise<void> {
        await $`systemctl enable ${this.unit(ref)}`.nothrow().quiet();
    }

    async start(ref: string): Promise<void> {
        await $`systemctl start ${this.unit(ref)}`.nothrow().quiet();
    }

    async restart(ref: string): Promise<void> {
        await $`systemctl restart ${this.unit(ref)}`.nothrow().quiet();
    }

    async stop(ref: string): Promise<void> {
        await $`systemctl stop ${this.unit(ref)}`.nothrow().quiet();
    }

    async disable(ref: string): Promise<void> {
        await $`systemctl disable ${this.unit(ref)}`.nothrow().quiet();
    }

    async resetFailed(ref: string): Promise<void> {
        await $`systemctl reset-failed ${this.unit(ref)}`.nothrow().quiet();
    }

    async observe(ref: string, port: number): Promise<Pick<GotrueRuntimeStatus, "actual" | "health" | "last_error">> {
        if (!(await this.isActive(ref))) {
            return { actual: "stopped", health: "unknown", last_error: null };
        }

        try {
            const res = await fetch(`http://127.0.0.1:${port}/health`, {
                signal: AbortSignal.timeout(3000),
            });
            if (res.ok) {
                return { actual: "running", health: "healthy", last_error: null };
            }
            return {
                actual: "error",
                health: "unhealthy",
                last_error: `GoTrue health check failed with HTTP ${res.status}`,
            };
        } catch (error: unknown) {
            return {
                actual: "error",
                health: "unhealthy",
                last_error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    async startOrRepair(
        ref: string,
        port: number,
        mode: "restart" | "repair",
    ): Promise<GotrueRuntimeStatus> {
        const active = await this.isActive(ref);
        const shouldRestart = active && (
            mode === "restart" ||
            (mode === "repair" && (await this.observe(ref, port)).health !== "healthy")
        );

        if (await this.isFailed(ref)) {
            await this.resetFailed(ref);
        }

        await this.enable(ref);
        if (shouldRestart) {
            await this.restart(ref);
        } else if (!active) {
            await this.start(ref);
        }

        return this.waitForHealthy(ref, port);
    }

    async waitForHealthy(
        ref: string,
        port: number,
        attempts = 10,
        delayMs = 500,
    ): Promise<GotrueRuntimeStatus> {
        let status = await this.observe(ref, port);
        for (let tryIdx = 0; tryIdx < attempts && status.health !== "healthy"; tryIdx++) {
            await Bun.sleep(delayMs);
            status = await this.observe(ref, port);
        }
        return {
            component: "gotrue",
            desired: "running",
            actual: status.actual,
            port,
            unit: this.unit(ref),
            health: status.health,
            last_error: status.last_error,
            updated_at: null,
            last_reconciled_at: null,
        };
    }

    async stopAndDisable(ref: string): Promise<void> {
        await this.stop(ref);
        await this.disable(ref);
    }
}

class TenantRuntimeService {
    private readonly TENANT_CONFIG_DIR = config.tenantConfigDir;
    private readonly PGREDIS_CONFIG_DIR = config.pgredisTenantConfigDir;
    private readonly PGREDIS_CONFIG_OWNER = config.pgredisTenantConfigOwner;
    private readonly POSTGREST_BIN = config.postgrestBin;
    private readonly POSTGREST_RTS = config.postgrestRts;
    private readonly POSTGREST_MEMORY_MAX = config.postgrestMemoryMax;
    private readonly POSTGREST_CPU_WEIGHT = config.postgrestCpuWeight;
    private readonly POSTGREST_DB_POOL = config.postgrestDbPool;
    private readonly GOTRUE_BIN = config.gotrueBin;
    private readonly PG_HOST = config.pgHost;
    private readonly PG_PORT = String(config.pgPort);

    private readonly PGRST_PORT_BASE = config.pgrstPortBase;
    private readonly GOTRUE_PORT_BASE = config.gotruePortBase;
    private readonly postgrestController = new PostgrestRuntimeController();
    private readonly gotrueController = new GotrueRuntimeController();
    private readonly tenantConfigLocks = new Map<string, Promise<void>>();
    private readonly postgrestPoolMigrationGate = new PostgrestPoolMigrationGate();

    private async withTenantConfigLock<T>(ref: string, operation: () => Promise<T>): Promise<T> {
        const predecessor = this.tenantConfigLocks.get(ref) || Promise.resolve();
        let releaseLock: () => void = () => {};
        const lock = new Promise<void>((resolve) => { releaseLock = resolve; });
        const queuedLock = predecessor.then(() => lock);
        this.tenantConfigLocks.set(ref, queuedLock);
        await predecessor;
        try {
            return await operation();
        } finally {
            releaseLock();
            if (this.tenantConfigLocks.get(ref) === queuedLock) this.tenantConfigLocks.delete(ref);
        }
    }

    private async livePostgrestAttestation(
        ref: string,
        port: number,
        desiredRevision: string,
    ): Promise<PostgrestAttestation> {
        return attestPostgrestRuntime({
            projectRef: ref,
            desiredRevision,
            port,
            unit: this.postgrestController.unit(ref),
            tenantDirectory: this.TENANT_CONFIG_DIR,
            postgrestBinary: this.POSTGREST_BIN,
        });
    }

    private async healthyPostgrestGeneration(
        ref: string,
        port: number,
        expectedRevision: string,
    ): Promise<PostgrestRuntimeStatus> {
        const status = await this.postgrestController.waitForHealthy(ref, port, 20, 500);
        if (status.health !== "healthy") {
            throw new Error(`PostgREST did not become healthy for ${ref}`);
        }
        const attestation = await this.livePostgrestAttestation(ref, port, expectedRevision);
        this.assertLoadedPostgrestGeneration(ref, expectedRevision, attestation);
        return status;
    }

    private async startOrRestartPostgrestGeneration(
        ref: string,
        port: number,
        expectedRevision: string,
    ): Promise<PostgrestRuntimeStatus> {
        const active = await this.postgrestController.isActive(ref);
        await this.postgrestController.enable(ref);
        if (active) await this.postgrestController.restart(ref);
        else await this.postgrestController.start(ref);
        return this.healthyPostgrestGeneration(ref, port, expectedRevision);
    }

    private async restorePostgrestGeneration(
        ref: string,
        port: number,
        activated: ActivatedPostgrestGeneration,
        previousPointerTarget: string | null,
    ): Promise<void> {
        if (!previousPointerTarget) {
            await this.cleanFailedFirstPostgrestGeneration(ref, activated);
            return;
        }
        const previous = await validatePostgrestGenerationTarget(
            this.TENANT_CONFIG_DIR,
            ref,
            previousPointerTarget,
            activated.ownership,
        );
        const currentPointerTarget = await readPostgrestPointerTarget(
            activated.layout.pointerPath,
            ref,
            activated.ownership,
        );
        if (currentPointerTarget !== activated.layout.pointerTarget) {
            throw new Error(`PostgREST generation pointer changed concurrently for ${ref}`);
        }
        const runtimeUser = await this.ensureTenantRuntimeUser(ref);
        await replacePostgrestPointer(
            activated.layout,
            previousPointerTarget,
            activated.ownership,
            (targetPath) => this.chownPath(targetPath, `root:${runtimeUser}`),
        );
        await this.startOrRestartPostgrestGeneration(ref, port, previous.revision);
    }

    private async cleanFailedFirstPostgrestGeneration(
        ref: string,
        activated: ActivatedPostgrestGeneration,
    ): Promise<void> {
        const shutdownErrors: unknown[] = [];
        try {
            await this.postgrestController.stop(ref);
        } catch (error: unknown) {
            shutdownErrors.push(error);
        }
        try {
            await this.postgrestController.disable(ref);
        } catch (error: unknown) {
            shutdownErrors.push(error);
        }
        if (shutdownErrors.length > 0) {
            throw new AggregateError(shutdownErrors, `Failed to stop first PostgREST generation for ${ref}`);
        }
        await removePostgrestPointerIfCurrent({
            layout: activated.layout,
            projectRef: ref,
            expectedPointerTarget: activated.layout.pointerTarget,
            ownership: activated.ownership,
        });
        if (await this.postgrestController.isActive(ref)) {
            throw new Error(`PostgREST remained active after first-generation cleanup for ${ref}`);
        }
    }

    private postgrestPoolGeneration(ref: string, content: string): PostgrestPoolGeneration {
        const canonicalContent = canonicalPostgrestConfig(content);
        const revision = postgrestConfigRevision(ref, canonicalContent);
        return {
            content: canonicalContent,
            pointerTarget: postgrestGenerationLayout(
                this.TENANT_CONFIG_DIR,
                ref,
                revision,
            ).pointerTarget,
            revision,
        };
    }

    private async readPostgrestPoolGeneration(
        context: PostgrestPoolContext,
    ): Promise<PostgrestPoolGeneration> {
        const pointerPath = path.join(this.TENANT_CONFIG_DIR, `${context.ref}_postgrest.current`);
        const pointerTarget = await readPostgrestPointerTarget(
            pointerPath,
            context.ref,
            context.ownership,
        );
        if (!pointerTarget) throw new Error(`PostgREST generation is unavailable for ${context.ref}`);
        const validated = await validatePostgrestGenerationTarget(
            this.TENANT_CONFIG_DIR,
            context.ref,
            pointerTarget,
            context.ownership,
        );
        return {
            content: await fs.readFile(validated.path, "utf8"),
            pointerTarget,
            revision: validated.revision,
        };
    }

    private async validatePostgrestPoolGeneration(
        context: PostgrestPoolContext,
        generation: PostgrestPoolGeneration,
    ): Promise<void> {
        const validated = await validatePostgrestGenerationTarget(
            this.TENANT_CONFIG_DIR,
            context.ref,
            generation.pointerTarget,
            context.ownership,
        );
        const content = await fs.readFile(validated.path, "utf8");
        if (validated.revision !== generation.revision || content !== generation.content) {
            throw new Error(`PostgREST generation changed during pool reconciliation for ${context.ref}`);
        }
    }

    private async activatePostgrestPoolGeneration(
        context: PostgrestPoolContext,
        content: string,
        expectedPreviousPointerTarget: string,
    ): Promise<PostgrestPoolGeneration> {
        const activated = await this.activateRenderedPostgrestGeneration({
            ref: context.ref,
            content,
            runtimeUser: context.runtimeUser,
            runtimeGroupGid: context.ownership.runtimeGroupGid,
            expectedPreviousPointerTarget,
        });
        if (activated.previousPointerTarget !== expectedPreviousPointerTarget) {
            throw new Error(`PostgREST generation changed before pool activation for ${context.ref}`);
        }
        return this.postgrestPoolGeneration(context.ref, content);
    }

    private async restorePostgrestPoolPointer(
        context: PostgrestPoolContext,
        generation: PostgrestPoolGeneration,
    ): Promise<void> {
        const layout = postgrestGenerationLayout(
            this.TENANT_CONFIG_DIR,
            context.ref,
            generation.revision,
        );
        await replacePostgrestPointer(
            layout,
            generation.pointerTarget,
            context.ownership,
            (targetPath) => this.chownPath(targetPath, `root:${context.runtimeUser}`),
        );
    }

    private postgrestPoolOperations(
        context: PostgrestPoolContext,
    ): PostgrestPoolReconcileOperations {
        return {
            readCurrentGeneration: () => this.readPostgrestPoolGeneration(context),
            candidateGeneration: (content) => this.postgrestPoolGeneration(context.ref, content),
            activateCandidate: (content, previous) =>
                this.activatePostgrestPoolGeneration(context, content, previous),
            currentPointerTarget: () => readPostgrestPointerTarget(
                path.join(this.TENANT_CONFIG_DIR, `${context.ref}_postgrest.current`),
                context.ref,
                context.ownership,
            ),
            validateGeneration: (generation) =>
                this.validatePostgrestPoolGeneration(context, generation),
            restorePointer: (generation) => this.restorePostgrestPoolPointer(context, generation),
            restartAndAttest: async (expectedRevision) => {
                const port = await this.getTenantPort(context.ref, "pgrst");
                await this.startOrRestartPostgrestGeneration(
                    context.ref,
                    port,
                    expectedRevision,
                );
            },
        };
    }

    private assertLoadedPostgrestGeneration(
        ref: string,
        expectedRevision: string,
        attestation: PostgrestAttestation,
    ): void {
        if (attestation.attestationState !== "loaded"
            || attestation.loadedRevision !== expectedRevision
            || attestation.matchesDesired !== true
            || attestation.health !== "healthy") {
            throw new Error(`PostgREST runtime attestation failed for ${ref}`);
        }
    }

    private async activatePostgrestGenerationUnlocked(
        ref: string,
        mode: PostgrestActivationMode,
    ): Promise<PostgrestRuntimeStatus | null> {
        await this.ensurePostgrestBinary();
        await this.installSystemdTemplate("checked");
        const pgrstPort = await this.getTenantPort(ref, "pgrst");
        const gotruePort = await this.getTenantPort(ref, "gotrue");
        const generation = await this.generateTenantConfigUnlocked(
            ref,
            pgrstPort,
            gotruePort,
            "checked",
        );
        return completePostgrestActivation({
            projectRef: ref,
            previousPointerTarget: generation.previousPointerTarget,
            activate: async () => {
                const active = await this.postgrestController.isActive(ref);
                if (!active && mode === "refresh-if-running") return null;
                if (active && mode === "ensure-running") {
                    const current = await this.livePostgrestAttestation(
                        ref,
                        pgrstPort,
                        generation.revision,
                    );
                    if (current.attestationState === "loaded"
                        && current.loadedRevision === generation.revision
                        && current.health === "healthy") {
                        return this.postgrestController.waitForHealthy(ref, pgrstPort, 1, 0);
                    }
                }
                return this.startOrRestartPostgrestGeneration(
                    ref,
                    pgrstPort,
                    generation.revision,
                );
            },
            rollback: (previousPointerTarget) => this.restorePostgrestGeneration(
                ref,
                pgrstPort,
                generation,
                previousPointerTarget,
            ),
        });
    }

    private async activatePostgrestGeneration(
        ref: string,
        mode: PostgrestActivationMode,
    ): Promise<PostgrestRuntimeStatus | null> {
        return this.withTenantConfigLock(ref, () =>
            this.activatePostgrestGenerationUnlocked(ref, mode));
    }

    private async effectiveGoTruePort(ref: string, localPort: number): Promise<number> {
        if (!isSharedAuthRuntime(ref)) return localPort;
        const [owner] = await metaSql`
          SELECT ref, status, config FROM projects
          WHERE ref=${config.authRuntimeOwnerRef} AND deleted_at IS NULL
        `;
        const ownerConfig = normalizeProjectConfig(owner?.config);
        const ownerPort = pickPositivePort(ownerConfig.gotrue_port);
        if (!owner || owner.status !== "active" || !ownerPort) {
            throw new Error(`shared auth runtime owner ${config.authRuntimeOwnerRef} is unavailable`);
        }
        return ownerPort;
    }

    // config.portRange is a string like "3100-3200". We just need the difference as the range size.
    private readonly PORT_RANGE = (() => {
        const parts = config.portRange.split('-');
        if (parts.length === 2) {
            return parseInt(parts[1]) - parseInt(parts[0]);
        }
        return parseInt(config.portRange); // fallback if it's just a number
    })();

    private deriveApiUrl(ref: string, projectConfig: Record<string, unknown> | null | undefined): string {
        return resolveProjectApiUrl(ref, projectConfig);
    }

    private deriveAuthUrl(ref: string, projectConfig: Record<string, unknown> | null | undefined): string {
        return resolveProjectAuthUrl(ref, projectConfig);
    }

    private async sharedAuthIssuer(ref: string): Promise<string | null> {
        const runtime = getAuthRuntimeDescriptor(ref);
        if (runtime.mode !== "shared") return null;
        const [owner] = await metaSql`
          SELECT config
          FROM projects
          WHERE ref=${runtime.authority_project_ref}
            AND deleted_at IS NULL
            AND lower(status) = 'active'
          LIMIT 1
        `;
        if (!owner) throw new Error(`Cannot find active SupAuth owner project ${runtime.authority_project_ref}`);
        const ownerConfig = normalizeProjectConfig(owner.config);
        const ownerAuth = (ownerConfig.auth as Record<string, unknown>) || {};
        const oauthServer = normalizeOAuthServerConfig(ownerAuth.oauth_server);
        return typeof oauthServer.issuer === "string" && oauthServer.issuer.trim()
            ? oauthServer.issuer.trim().replace(/\/+$/, "")
            : `${this.deriveAuthUrl(runtime.authority_project_ref, ownerConfig)}/auth/v1`;
    }

    private async readPersistedTenantPort(ref: string, type: "pgrst" | "gotrue"): Promise<number | null> {
        const [project] = await metaSql`
          SELECT config
          FROM projects
          WHERE ref=${ref} AND deleted_at IS NULL
        `;
        const projectConfig = normalizeProjectConfig(project?.config);
        const key = type === "pgrst" ? "postgrest_port" : "gotrue_port";
        return pickPositivePort(projectConfig[key]);
    }

    private async findTenantPortConflict(ref: string, type: "pgrst" | "gotrue", port: number): Promise<string | null> {
        let files: string[];
        try {
            files = await fs.readdir(this.TENANT_CONFIG_DIR);
        } catch (error: unknown) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
            throw error;
        }

        for (const file of files) {
            let existingRef = "";
            let content = "";
            let matches = false;

            if (type === "gotrue" && file.endsWith("_gotrue.env")) {
                existingRef = file.replace(/_gotrue\.env$/, "");
                content = await Bun.file(path.join(this.TENANT_CONFIG_DIR, file)).text();
                matches = content.includes(`GOTRUE_API_PORT=${port}`);
            } else if (type === "pgrst" && file.endsWith(".conf")) {
                existingRef = file.replace(/\.conf$/, "");
                content = await Bun.file(path.join(this.TENANT_CONFIG_DIR, file)).text();
                matches = new RegExp(`(^|\\n)\\s*server-port\\s*=\\s*${port}\\s*(\\n|$)`).test(content);
            } else if (type === "pgrst" && file.endsWith(".env") && !file.endsWith("_gotrue.env")) {
                existingRef = file.replace(/\.env$/, "");
                content = await Bun.file(path.join(this.TENANT_CONFIG_DIR, file)).text();
                matches = content.includes(`PGRST_SERVER_PORT=${port}`);
            }

            if (existingRef && existingRef !== ref && matches) return existingRef;
        }

        return null;
    }

    private async persistTenantPortConfig(ref: string, pgrstPort: number, gotruePort: number): Promise<void> {
        const [project] = await metaSql`
          SELECT config
          FROM projects
          WHERE ref=${ref} AND deleted_at IS NULL
        `;
        if (!project) return;

        const current = normalizeProjectConfig(project.config);
        if (current.postgrest_port === pgrstPort && current.gotrue_port === gotruePort) return;

        const next = {
            ...current,
            postgrest_port: pgrstPort,
            gotrue_port: gotruePort,
        };
        await metaSql`
          UPDATE projects
          SET config=${JSON.stringify(next)}::jsonb, updated_at=NOW()
          WHERE ref=${ref} AND deleted_at IS NULL
        `;
        logger.info(`Persisted tenant runtime ports for ${ref} (pgrst_port=${pgrstPort}, gotrue_port=${gotruePort})`);
    }

    /**
     * 优先使用已持久化端口，让网关路由和 systemd env 保持一致。
     * 端口缺失或已被其他租户占用时，再回退到 hash 分配。
     */
    private async getTenantPort(ref: string, type: "pgrst" | "gotrue"): Promise<number> {
        const basePort = type === "pgrst" ? this.PGRST_PORT_BASE : this.GOTRUE_PORT_BASE;
        const persistedPort = await this.readPersistedTenantPort(ref, type);
        if (persistedPort) {
            const conflictingRef = await this.findTenantPortConflict(ref, type, persistedPort);
            if (!conflictingRef) return persistedPort;
            logger.warn(`[TenantRuntime] Ignoring persisted ${type} port ${persistedPort} for ${ref}; already used by ${conflictingRef}`);
        }

        // 使用 bun:hash 保持原有确定性分配逻辑。
        const hash = Bun.hash(ref);
        // BigInt modulo 避免大整数取模溢出。
        let port = basePort + Number(BigInt(hash) % BigInt(this.PORT_RANGE));

        // 继续沿用最多 100 次的线性探测碰撞处理。
        const maxTries = 100;
        for (let tryIdx = 0; tryIdx < maxTries; tryIdx++) {
            if (!(await this.findTenantPortConflict(ref, type, port))) return port;
            port++;
        }

        throw new Error(`Cannot find available port for ${ref} (${type})`);
    }

    /**
     * Retrieve credentials from supacloud_meta (local metadata DB)
     * Uses the global connection pool from db/index.ts
     */
    private async getTenantCredentials(ref: string) {
        const [project] = await metaSql`
          SELECT db_password, jwt_secret, config, db_name, anon_key, service_role_key,
                 publishable_key, secret_key_encrypted, status, postgrest_desired
          FROM projects
          WHERE ref=${ref}
        `;

        if (!project || !project.db_password || !project.jwt_secret) {
            throw new Error(`Cannot find valid credentials for project ${ref} in supacloud_meta`);
        }
        if (typeof project.db_name !== "string" || !project.db_name.trim()) {
            throw new Error(`Cannot find authoritative database name for project ${ref}`);
        }

        const projectConfig = normalizeProjectConfig(project.config);
        const { authConfig, siteUrl, uriAllowList } = resolveTenantAuthUrlSettings(ref, projectConfig);
        const oauthServerConfig = normalizeOAuthServerConfig(authConfig.oauth_server);
        const jwtKeys = stringifyJsonConfig(normalizeProjectJwtKeys(oauthServerConfig.jwt_keys));
        let jwtMaterial = resolveProjectJwtVerificationMaterial(projectConfig, project.jwt_secret);
        let localJwtIssuer = typeof oauthServerConfig.issuer === "string" && oauthServerConfig.issuer.trim()
            ? oauthServerConfig.issuer.trim().replace(/\/+$/, "")
            : null;
        const authRuntime = getAuthRuntimeDescriptor(ref);
        if (authRuntime.mode === "shared") {
            const [owner] = await metaSql`
              SELECT config
              FROM projects
              WHERE ref=${authRuntime.authority_project_ref}
                AND deleted_at IS NULL
                AND lower(status) = 'active'
              LIMIT 1
            `;
            if (!owner) {
                throw new Error(`Cannot find active SupAuth owner project ${authRuntime.authority_project_ref}`);
            }
            const ownerConfig = normalizeProjectConfig(owner.config);
            jwtMaterial = buildSharedProjectJwtVerificationMaterial({
                projectJwtSecret: String(project.jwt_secret),
                projectConfig: project.config,
                ownerConfig: owner.config,
            });
            const ownerAuth = (ownerConfig.auth as Record<string, unknown>) || {};
            const ownerOauthServer = normalizeOAuthServerConfig(ownerAuth.oauth_server);
            localJwtIssuer = typeof ownerOauthServer.issuer === "string" && ownerOauthServer.issuer.trim()
                ? ownerOauthServer.issuer.trim().replace(/\/+$/, "")
                : `${this.deriveAuthUrl(authRuntime.authority_project_ref, ownerConfig)}/auth/v1`;
        }
        const jwtJwks = stringifyJsonConfig(jwtMaterial.jwtJwks);
        return {
            dbPassword: project.db_password,
            jwtSecret: project.jwt_secret,
            jwtKeys,
            jwtJwks,
            thirdPartyJwtPolicy: jwtMaterial.thirdParty,
            localJwtIssuer,
            dbName: project.db_name,
            apiUrl: this.deriveApiUrl(ref, projectConfig),
            authUrl: this.deriveAuthUrl(ref, projectConfig),
            anonKey: project.anonKey || project.anon_key,
            serviceRoleKey: project.serviceRoleKey || project.service_role_key,
            publishableKey: project.publishable_key || "",
            secretKey: project.secret_key_encrypted
                ? decryptSecretIfNeeded(String(project.secret_key_encrypted))
                : "",
            postgrestPort: pickPositivePort(projectConfig.postgrest_port),
            projectStatus: String(project.status || ""),
            postgrestDesired: project.postgrest_desired,
            siteUrl,
            uriAllowList,
            authConfig
        };
    }

    /**
     * Ensure binaries exist at their configured paths.
     * PostgREST and GoTrue must be pre-installed; no container fallback.
     */
    private async ensurePostgrestBinary() {
        const pgrstCheck = await $`which postgrest`.nothrow().quiet();
        const hasPgrstBin = await Bun.file(this.POSTGREST_BIN).exists();

        if (pgrstCheck.exitCode !== 0 && !hasPgrstBin) {
            const runtimeInstaller = path.join(config.scriptsPath, "lib", "tenant_runtime.sh");
            throw new Error(
                `PostgREST binary not found at ${this.POSTGREST_BIN} or in PATH. ` +
                `Use the trusted SHA-pinned ensure_postgrest function in ${runtimeInstaller}; ` +
                "do not download an unverified latest release manually."
            );
        }
    }

    private async ensureGotrueBinary() {
        const gotrueCheck = await $`which gotrue`.nothrow().quiet();
        const hasGotrueBin = await Bun.file(this.GOTRUE_BIN).exists();

        if (gotrueCheck.exitCode !== 0 && !hasGotrueBin) {
            const runtimeInstaller = path.join(config.scriptsPath, "lib", "tenant_runtime.sh");
            throw new Error(
                `GoTrue binary not found at ${this.GOTRUE_BIN} or in PATH. ` +
                `Use the trusted SHA-pinned ensure_gotrue function in ${runtimeInstaller}; ` +
                "do not download an unverified latest release manually."
            );
        }
    }

    private async ensurePasskeyGoTrueVersion(authConfig: Record<string, unknown>): Promise<void> {
        if (renderGoTruePasskeyEnv(authConfig) === "GOTRUE_PASSKEY_ENABLED=false") return;
        await this.ensureGotrueBinary();
        const configuredBinaryExists = await Bun.file(this.GOTRUE_BIN).exists();
        const binary = configuredBinaryExists ? this.GOTRUE_BIN : "gotrue";
        const versionResult = await this.runStructuredCommand([binary, "version"]);
        const version = versionResult.stdout.trim().split(/\s+/)[0] || "";
        if (versionResult.exitCode !== 0 || !isGoTruePasskeyVersionSupported(version)) {
            throw new Error(`Passkey requires GoTrue v2.194.0 or newer; detected ${version || "unknown"}`);
        }
    }

    private async ensureBinaries() {
        await this.ensurePostgrestBinary();
        await this.ensureGotrueBinary();
    }

    private tenantRuntimeUser(ref: string): string {
        if (!/^[a-z0-9-]{1,20}$/.test(ref)) {
            throw new Error("Invalid tenant project ref");
        }
        return `supacloud-${ref}`;
    }

    private async runStructuredCommand(cmd: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        const child = Bun.spawn({
            cmd,
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        return { exitCode, stdout, stderr };
    }

    async ensureTenantRuntimeUser(ref: string): Promise<string> {
        const runtimeUser = this.tenantRuntimeUser(ref);
        // ProtectSystem=full deliberately keeps the long-running control plane
        // out of the system account database. Always run the fixed helper so it
        // validates pre-existing account attributes instead of trusting a UID.
        const helperUnit = `supacloud-tenant-user@${ref}.service`;
        const created = await this.runStructuredCommand(["systemctl", "start", helperUnit]);
        if (created.exitCode !== 0) {
            throw new Error(
                `Failed to create or validate tenant runtime user ${runtimeUser} through ${helperUnit}: ` +
                created.stderr.trim().slice(0, 300),
            );
        }
        const verified = await this.runStructuredCommand(["id", "-u", runtimeUser]);
        if (verified.exitCode !== 0) {
            throw new Error(`Tenant runtime user ${runtimeUser} is missing after ${helperUnit} completed`);
        }
        return runtimeUser;
    }

    private async tenantRuntimeGroupId(runtimeUser: string): Promise<number> {
        const group = await this.runStructuredCommand(["id", "-g", runtimeUser]);
        const rawGroupId = group.stdout.trim();
        if (group.exitCode !== 0 || !/^\d+$/.test(rawGroupId)) {
            throw new Error(`Tenant runtime group ${runtimeUser} is unavailable`);
        }
        return Number(rawGroupId);
    }

    private async activateRenderedPostgrestGeneration(
        request: RenderedPostgrestGenerationRequest,
    ): Promise<ActivatedPostgrestGeneration> {
        return activatePostgrestGeneration({
            tenantDirectory: this.TENANT_CONFIG_DIR,
            projectRef: request.ref,
            content: request.content,
            expectedPreviousPointerTarget: request.expectedPreviousPointerTarget,
            controlOwnerUid: 0,
            runtimeGroupGid: request.runtimeGroupGid,
            setControlOwnership: (targetPath) =>
                this.chownPath(targetPath, `root:${request.runtimeUser}`),
        });
    }

    private async chownTenantPath(targetPath: string, runtimeUser: string): Promise<void> {
        const result = await this.runStructuredCommand(["chown", `${runtimeUser}:${runtimeUser}`, targetPath]);
        if (result.exitCode !== 0) {
            throw new Error(`Failed to set tenant ownership on ${path.basename(targetPath)}: ${result.stderr.trim().slice(0, 300)}`);
        }
    }

    private async chownPath(targetPath: string, owner: string): Promise<void> {
        const result = await this.runStructuredCommand(["chown", owner, targetPath]);
        if (result.exitCode !== 0) {
            throw new Error(`Failed to set ownership on ${path.basename(targetPath)}: ${result.stderr.trim().slice(0, 300)}`);
        }
    }

    private async writeTenantSecretFile(
        targetPath: string,
        content: string,
        runtimeUser?: string,
        owner?: string,
    ): Promise<void> {
        const directory = path.dirname(targetPath);
        const tempPath = path.join(directory, `.${path.basename(targetPath)}.${crypto.randomUUID()}.tmp`);
        try {
            await fs.writeFile(tempPath, `${content}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
            await fs.chmod(tempPath, 0o600);
            if (owner) await this.chownPath(tempPath, owner);
            else if (runtimeUser) await this.chownTenantPath(tempPath, runtimeUser);
            await fs.rename(tempPath, targetPath);
            await fs.chmod(targetPath, 0o600);
        } finally {
            await fs.rm(tempPath, { force: true }).catch(() => {});
        }
    }

    private async writeTemporaryTenantSql(ref: string, prefix: string, content: string): Promise<{ directory: string; file: string }> {
        this.tenantRuntimeUser(ref);
        const directory = await fs.mkdtemp(path.join("/tmp", `${prefix}-${ref}-`));
        await fs.chmod(directory, 0o700);
        const file = path.join(directory, "migration.sql");
        await fs.writeFile(file, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await fs.chmod(file, 0o600);
        return { directory, file };
    }

    private async runTenantPsql(
        connection: PostgresConnectionConfig,
        args: readonly string[],
    ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        const invocation = buildTenantPsqlInvocation(connection, args);
        const child = Bun.spawn({
            cmd: invocation.cmd,
            env: { ...process.env, ...invocation.env },
            stdout: "pipe",
            stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        return { exitCode, stdout, stderr };
    }

    private async runTenantPsqlOrThrow(
        connection: PostgresConnectionConfig,
        args: readonly string[],
        label: string,
    ): Promise<{ stdout: string; stderr: string }> {
        const result = await this.runTenantPsql(connection, args);
        if (result.exitCode !== 0) {
            const detail = result.stderr.trim() || result.stdout.trim() || "psql exited without output";
            throw new Error(`psql exited with code ${result.exitCode} during ${label}: ${detail.slice(0, 500)}`);
        }
        return result;
    }

    private adminPsqlConnection(database: string): PostgresConnectionConfig {
        return {
            user: "postgres",
            password: config.pgPassword,
            host: this.PG_HOST,
            port: this.PG_PORT,
            database,
        };
    }

    private async queryPgmqPublicSchema(ref: string, dbName: string, dbPassword: string): Promise<boolean> {
        const query = "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgmq_public') THEN 1 ELSE 0 END;";
        const result = await this.runTenantPsql({
            user: resolveAuthenticatorName(ref),
            password: dbPassword,
            host: this.PG_HOST,
            port: this.PG_PORT,
            database: dbName,
        }, ["-Atqc", query]);
        if (result.exitCode !== 0) {
            throw new Error(`Unable to read authoritative PostgREST schemas for ${ref}`);
        }
        return result.stdout.trim() === "1";
    }

    private async hasPgmqPublicSchema(ref: string, dbName: string, dbPassword: string): Promise<boolean> {
        try {
            return await this.queryPgmqPublicSchema(ref, dbName, dbPassword);
        } catch (error: unknown) {
            logger.warn(`[tenant-runtime] Failed to detect pgmq_public schema for ${ref}; falling back to base PostgREST schemas`, {
                error: error instanceof Error ? error.message : String(error),
            });
            return false;
        }
    }

    private renderPostgrestCredentialConfig(
        ref: string,
        pgrstPort: number,
        credentials: PostgrestCredentialMaterial,
        databaseSchemas: string,
    ): string {
        const databaseUri = buildPostgresUri({
            protocol: "postgres",
            user: resolveAuthenticatorName(ref),
            password: credentials.dbPassword,
            host: this.PG_HOST,
            port: this.PG_PORT,
            database: credentials.dbName,
        });
        return renderDesiredPostgrestConfig({
            projectRef: ref,
            databaseUri,
            databaseSchemas,
            jwtVerifierSecret: credentials.jwtJwks || credentials.jwtSecret,
            jwtAudience: isSharedAuthRuntime(ref)
                ? ""
                : (credentials.thirdPartyJwtPolicy?.audience[0] || ""),
            port: pgrstPort,
            databasePool: this.POSTGREST_DB_POOL,
            apiUrl: credentials.apiUrl,
        });
    }

    private async desiredPostgrestConfig(
        ref: string,
        pgrstPort: number,
        credentials: PostgrestCredentialMaterial,
    ): Promise<string> {
        const databaseSchemas = renderPostgrestDbSchemas(
            await this.hasPgmqPublicSchema(ref, credentials.dbName, credentials.dbPassword),
        );
        return this.renderPostgrestCredentialConfig(
            ref,
            pgrstPort,
            credentials,
            databaseSchemas,
        );
    }

    private async readAuthoritativePostgrestDesired(
        ref: string,
    ): Promise<AuthoritativePostgrestDesired> {
        const credentials = await this.getTenantCredentials(ref);
        if (!credentials.postgrestPort) {
            throw new Error(`Project ${ref} has no authoritative PostgREST port`);
        }
        const databaseSchemas = renderPostgrestDbSchemas(
            await this.queryPgmqPublicSchema(ref, credentials.dbName, credentials.dbPassword),
        );
        const content = this.renderPostgrestCredentialConfig(
            ref,
            credentials.postgrestPort,
            credentials,
            databaseSchemas,
        );
        return {
            revision: postgrestConfigRevision(ref, content),
            desired: this.getPostgrestDesiredState({
                status: credentials.projectStatus,
                postgrest_desired: credentials.postgrestDesired,
            }),
            port: credentials.postgrestPort,
        };
    }

    private async stableAuthoritativePostgrestDesired(
        ref: string,
    ): Promise<AuthoritativePostgrestDesired> {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const before = await this.readAuthoritativePostgrestDesired(ref);
            const after = await this.readAuthoritativePostgrestDesired(ref);
            if (before.revision === after.revision
                && before.desired === after.desired
                && before.port === after.port) {
                return after;
            }
        }
        throw new Error(`Authoritative PostgREST configuration is unstable for ${ref}`);
    }

    public async runtimeSnapshotPostgrest(ref: string): Promise<PostgrestRuntimeSnapshot> {
        const desired = await this.stableAuthoritativePostgrestDesired(ref);
        const attestation = await attestPostgrestRuntime({
            projectRef: ref,
            desiredRevision: desired.revision,
            port: desired.port,
            unit: this.postgrestController.unit(ref),
            tenantDirectory: this.TENANT_CONFIG_DIR,
            postgrestBinary: this.POSTGREST_BIN,
        });
        if (attestation.desiredRevision !== desired.revision) {
            throw new Error(`PostgREST attestation lost authoritative revision for ${ref}`);
        }
        return {
            ...attestation,
            desiredRevision: desired.revision,
            desired: desired.desired,
            port: desired.port,
            unit: this.postgrestController.unit(ref),
        };
    }

    private async generateTenantConfig(
        ref: string,
        pgrstPort: number,
        gotruePort: number,
        systemctlMode: SystemctlExecutionMode = "best-effort",
    ) {
        return this.withTenantConfigLock(ref, () =>
            this.generateTenantConfigUnlocked(ref, pgrstPort, gotruePort, systemctlMode));
    }

    private async generateTenantConfigUnlocked(
        ref: string,
        pgrstPort: number,
        gotruePort: number,
        systemctlMode: SystemctlExecutionMode,
    ) {
        const creds = await this.getTenantCredentials(ref);
        const runtimeUser = await this.ensureTenantRuntimeUser(ref);
        const runtimeGroupGid = await this.tenantRuntimeGroupId(runtimeUser);
        await fs.mkdir(this.TENANT_CONFIG_DIR, { recursive: true, mode: 0o711 });
        await fs.chmod(this.TENANT_CONFIG_DIR, 0o711);

        const runtimeGoTruePort = await this.effectiveGoTruePort(ref, gotruePort);
        for (const [name, value] of Object.entries({
            dbPassword: creds.dbPassword,
            jwtSecret: creds.jwtSecret,
            jwtKeys: creds.jwtKeys || "",
            jwtJwks: creds.jwtJwks || "",
            thirdPartyJwtPolicy: creds.thirdPartyJwtPolicy ? JSON.stringify(creds.thirdPartyJwtPolicy) : "",
            localJwtIssuer: creds.localJwtIssuer || "",
            dbName: creds.dbName,
            apiUrl: creds.apiUrl,
            authUrl: creds.authUrl,
            anonKey: String(creds.anonKey || ""),
            serviceRoleKey: String(creds.serviceRoleKey || ""),
            siteUrl: creds.siteUrl,
            uriAllowList: creds.uriAllowList,
        })) {
            assertSafeConfigValue(`tenant ${name}`, String(value));
        }
        const authDbUri = buildPostgresUri({
            protocol: "postgres",
            user: "supabase_auth_admin",
            password: config.pgPassword,
            host: this.PG_HOST,
            port: this.PG_PORT,
            database: creds.dbName,
        });

        const sharedAuthRuntime = isSharedAuthRuntime(ref);
        const jwtJwksEnv = creds.jwtJwks ? renderSystemdEnvLine("JWT_JWKS", creds.jwtJwks) : "";
        const jwtKeysEnv = creds.jwtKeys ? renderSystemdEnvLine("JWT_KEYS", creds.jwtKeys) : "";
        const thirdPartyJwtPolicyEnv = creds.thirdPartyJwtPolicy
            ? renderSystemdEnvLine("SUPACLOUD_THIRD_PARTY_JWT_POLICY", JSON.stringify(creds.thirdPartyJwtPolicy))
            : "";
        // Generate PostgREST .env configuration
        // Edge runtime and other services consume these env vars
        const pgrstEnv = [
            `
# Managed by SupaCloud Management API. Legacy shell tooling must not overwrite this file.
# SupaCloud Tenant PostgREST Runtime: ${ref}
# PGRST_* variables have been removed to avoid duplicate configuration (P2-2)
# PostgREST configuration is now single-sourced from the .conf file.

# SupaCloud Edge Runtime Injection
`.trim(),
            renderSystemdEnvLine("SUPABASE_URL", creds.apiUrl),
            renderSystemdEnvLine("SUPABASE_ANON_KEY", String(creds.anonKey || "")),
            renderSystemdEnvLine("SUPABASE_SERVICE_ROLE_KEY", String(creds.serviceRoleKey || "")),
            renderSystemdEnvLine("SUPABASE_PUBLISHABLE_KEY", String(creds.publishableKey || "")),
            renderSystemdEnvLine("SUPABASE_SECRET_KEY", String(creds.secretKey || "")),
            sharedAuthRuntime ? "" : renderSystemdEnvLine("JWT_SECRET", creds.jwtSecret),
            renderSystemdEnvLine("SUPACLOUD_AUTH_RUNTIME_MODE", sharedAuthRuntime ? "shared" : "local"),
            renderSystemdEnvLine("SUPACLOUD_AUTH_AUTHORITY_REF", getAuthRuntimeDescriptor(ref).authority_project_ref),
            sharedAuthRuntime && creds.localJwtIssuer
                ? renderSystemdEnvLine("SUPACLOUD_AUTH_ISSUER", creds.localJwtIssuer)
                : "",
            renderTenantInternalRuntimeEnv(pgrstPort, runtimeGoTruePort),
            jwtJwksEnv,
            sharedAuthRuntime ? "" : jwtKeysEnv,
            thirdPartyJwtPolicyEnv,
        ].filter(Boolean).join("\n");
        await this.writeTenantSecretFile(
            path.join(this.TENANT_CONFIG_DIR, `${ref}.env`),
            pgrstEnv,
            runtimeUser,
        );
        await this.writePgredisTenantConfig(ref, creds.dbName, creds.dbPassword);

        const pgrstConf = await this.desiredPostgrestConfig(ref, pgrstPort, creds);
        // 共享认证模式下从项目只使用主项目 GoTrue，不再生成本地认证运行时。
        if (sharedAuthRuntime) {
            const sharedMarkerPath = path.join(this.TENANT_CONFIG_DIR, `${ref}_gotrue.shared`);
            await this.writeTenantSecretFile(
                sharedMarkerPath,
                `${config.authRuntimeOwnerRef}\n`,
                runtimeUser,
            );
            if (systemctlMode === "checked") {
                const unit = this.gotrueController.unit(ref);
                await runSystemctlOrThrow("stop", unit);
                await runSystemctlOrThrow("disable", unit);
            } else {
                await this.gotrueController.stopAndDisable(ref);
            }
            await this.persistTenantPortConfig(ref, pgrstPort, gotruePort);
            const postgrestGeneration = await this.activateRenderedPostgrestGeneration({
                ref,
                content: pgrstConf,
                runtimeUser,
                runtimeGroupGid,
            });
            logger.info(`Config generated for ${ref} with shared GoTrue owner ${config.authRuntimeOwnerRef}`);
            return postgrestGeneration;
        }

        await fs.rm(path.join(this.TENANT_CONFIG_DIR, `${ref}_gotrue.shared`), { force: true });
        await this.ensurePasskeyGoTrueVersion(creds.authConfig);

        // Generate GoTrue .env configuration
        const hasDedicatedAuthUrl = Boolean(creds.authUrl && creds.authUrl !== creds.apiUrl);
        const apiExternalUrl = hasDedicatedAuthUrl ? creds.authUrl : creds.apiUrl;
        const siteExternalUrl = hasDedicatedAuthUrl ? creds.authUrl : creds.siteUrl;
        const redirectOrigins = uniqueStrings([
            creds.uriAllowList,
            creds.siteUrl,
            creds.apiUrl,
            creds.authUrl,
        ].flatMap((value) => String(value || "").split(",")));
        const gotrueSender = config.gotrueSmtpAdminEmail || `noreply@${apiExternalUrl.replace('https://', '').replace('http://', '')}`;
        const managedSecretEnvLines = await renderManagedGoTrueSecretEnv(ref, creds.authConfig);

        const gotrueEnvLines = [
            `
# Managed by SupaCloud Management API. Legacy shell tooling must not overwrite this file.
# SupaCloud Tenant GoTrue Runtime: ${ref}
`.trim(),
            renderSystemdEnvLine("GOTRUE_API_HOST", "0.0.0.0"),
            `GOTRUE_API_PORT=${gotruePort}`,
            renderSystemdEnvLine("API_EXTERNAL_URL", apiExternalUrl),
            renderSystemdEnvLine("GOTRUE_SITE_URL", siteExternalUrl),
            renderSystemdEnvLine("GOTRUE_URI_ALLOW_LIST", redirectOrigins.join(",")),
            renderSystemdEnvLine("GOTRUE_DB_DRIVER", "postgres"),
            renderSystemdEnvLine("GOTRUE_DB_DATABASE_URL", authDbUri),
            `GOTRUE_DB_MAX_POOL_SIZE=${config.gotrueDbPool}`,
            renderSystemdEnvLine("GOTRUE_JWT_SECRET", creds.jwtSecret),
            `
GOTRUE_JWT_AUD=authenticated
GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated
GOTRUE_LOG_LEVEL=info
GOTRUE_SERVER_READ_TIMEOUT=20
GOTRUE_RELOADING_SIGNAL_ENABLED=true
GOTRUE_RELOADING_POLLER_ENABLED=true
GOTRUE_MAILER_URLPATHS_CONFIRMATION=/auth/v1/verify
GOTRUE_MAILER_URLPATHS_INVITE=/auth/v1/verify
GOTRUE_MAILER_URLPATHS_RECOVERY=/auth/v1/verify
GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE=/auth/v1/verify
`.trim(),
            renderGoTrueSessionPolicyEnv(creds.authConfig),
            renderGoTrueAuthEnv(creds.authConfig),
            renderGoTruePasskeyEnv(creds.authConfig),
            renderGoTrueProviderLinkingEnv(creds.authConfig),
            renderGoTrueSamlEnv(creds.authConfig),
            ...managedSecretEnvLines,
            "# Admin Operator Token (P0-6)",
            renderSystemdEnvLine("GOTRUE_OPERATOR_TOKEN", String(config.masterToken || creds.serviceRoleKey || "")),
        ];

        const oauthServerConfig = normalizeOAuthServerConfig(creds.authConfig.oauth_server);
        if (oauthServerConfig.enabled === true) {
            const authorizationPath = typeof oauthServerConfig.authorization_path === "string"
                ? oauthServerConfig.authorization_path
                : "";
            const issuer = typeof oauthServerConfig.issuer === "string" && oauthServerConfig.issuer
                ? oauthServerConfig.issuer
                : `${apiExternalUrl}/auth/v1`;
            gotrueEnvLines.push(
                "# OAuth 2.1 / OIDC Provider Configuration",
                "GOTRUE_OAUTH_SERVER_ENABLED=true",
                `GOTRUE_OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION=${oauthServerConfig.allow_dynamic_registration === true ? "true" : "false"}`,
                renderSystemdEnvLine("GOTRUE_JWT_ISSUER", issuer),
            );
            if (authorizationPath) {
                gotrueEnvLines.push(renderSystemdEnvLine("GOTRUE_OAUTH_SERVER_AUTHORIZATION_PATH", authorizationPath));
            }
            if (creds.jwtKeys) {
                gotrueEnvLines.push(
                    renderSystemdEnvLine("GOTRUE_JWT_KEYS", creds.jwtKeys),
                    renderSystemdEnvLine("JWT_KEYS", creds.jwtKeys),
                );
            }
        }

        if (config.gotrueSmtpHost) {
            gotrueEnvLines.push(
                "# SMTP Configuration",
                renderSystemdEnvLine("GOTRUE_SMTP_ADMIN_EMAIL", gotrueSender),
                renderSystemdEnvLine("GOTRUE_SMTP_HOST", config.gotrueSmtpHost),
                "GOTRUE_SMTP_PORT=587",
                renderSystemdEnvLine("GOTRUE_SMTP_USER", config.gotrueSmtpUser),
                renderSystemdEnvLine("GOTRUE_SMTP_PASS", config.gotrueSmtpPass),
                renderSystemdEnvLine("GOTRUE_SMTP_SENDER_NAME", "SupaCloud"),
            );
            if (creds.authConfig.mailer_autoconfirm) {
                gotrueEnvLines.push("GOTRUE_MAILER_AUTOCONFIRM=true");
            }
        } else {
            // P1-1: Enable auto-confirm if no SMTP is configured so users can register
            gotrueEnvLines.push(
                "# Local Dev / No-SMTP Configuration",
                "GOTRUE_MAILER_AUTOCONFIRM=true",
            );
        }
        const gotrueEnv = gotrueEnvLines.filter(Boolean).join("\n");
        const gotrueEnvPath = path.join(this.TENANT_CONFIG_DIR, `${ref}_gotrue.env`);
        const gotrueConfigDir = path.join(this.TENANT_CONFIG_DIR, `${ref}_gotrue.d`);
        await fs.mkdir(gotrueConfigDir, { recursive: true, mode: 0o700 });
        await fs.chmod(gotrueConfigDir, 0o700);
        await this.chownTenantPath(gotrueConfigDir, runtimeUser);
        await this.writeTenantSecretFile(path.join(gotrueConfigDir, "runtime.env"), gotrueEnv, runtimeUser);
        // Keep the legacy flat env file for older units and diagnostics.
        await this.writeTenantSecretFile(gotrueEnvPath, gotrueEnv, runtimeUser);
        await this.persistTenantPortConfig(ref, pgrstPort, gotruePort);

        const postgrestGeneration = await this.activateRenderedPostgrestGeneration({
            ref,
            content: pgrstConf,
            runtimeUser,
            runtimeGroupGid,
        });

        logger.info(`Config generated for ${ref} (pgrst_port=${pgrstPort}, gotrue_port=${gotruePort})`);
        return postgrestGeneration;
    }

    private async writePgredisTenantConfig(ref: string, database: string, password: string): Promise<void> {
        await fs.mkdir(this.PGREDIS_CONFIG_DIR, { recursive: true, mode: 0o700 });
        await fs.chmod(this.PGREDIS_CONFIG_DIR, 0o700);
        if (this.PGREDIS_CONFIG_OWNER) {
            await this.chownPath(this.PGREDIS_CONFIG_DIR, this.PGREDIS_CONFIG_OWNER);
        }
        const databaseUrl = buildPostgresUri({
            protocol: "postgresql",
            user: resolveRoleName(ref),
            password,
            host: this.PG_HOST,
            port: this.PG_PORT,
            database,
        });
        await this.writeTenantSecretFile(
            path.join(this.PGREDIS_CONFIG_DIR, `${ref}_pgredis.env`),
            renderSystemdEnvLine("PGREDIS_DATABASE_URL", databaseUrl),
            undefined,
            this.PGREDIS_CONFIG_OWNER || undefined,
        );
    }

    public async ensurePgredisTenantConfig(ref: string): Promise<void> {
        await this.withTenantConfigLock(ref, async () => {
            const credentials = await this.getTenantCredentials(ref);
            await this.writePgredisTenantConfig(ref, credentials.dbName, credentials.dbPassword);
        });
    }

    private async installSystemdTemplate(systemctlMode: SystemctlExecutionMode = "best-effort") {
        const pgrstUnitPath = "/etc/systemd/system/supacloud-pgrst@.service";
        const gotrueUnitPath = "/etc/systemd/system/supacloud-gotrue@.service";

        // Avoid redundant disk IO unless upgrading the old 30 MB PostgREST unit.
        const pgrstExists = await Bun.file(pgrstUnitPath).exists();
        const currentPgrstUnit = pgrstExists
            ? await Bun.file(pgrstUnitPath).text().catch(() => "")
            : "";
        const shouldWritePgrstUnit = !pgrstExists
            || await unitHasLegacyPostgrestMemoryLimit(pgrstUnitPath)
            || !currentPgrstUnit.includes("User=supacloud-%i")
            || !currentPgrstUnit.includes("Group=supacloud-%i")
            || !currentPgrstUnit.includes("/usr/local/libexec/supacloud/postgrest-launcher %i")
            || currentPgrstUnit.includes(`EnvironmentFile=${this.TENANT_CONFIG_DIR}/%i.env`);
        if (shouldWritePgrstUnit) {
            const pgrstUnit = renderPostgrestSystemdTemplate({
                postgrestRts: this.POSTGREST_RTS,
                postgrestBinary: this.POSTGREST_BIN,
                tenantConfigDir: this.TENANT_CONFIG_DIR,
                memoryMax: this.POSTGREST_MEMORY_MAX,
                cpuWeight: this.POSTGREST_CPU_WEIGHT,
            });
            await installManagedSystemdUnit("supacloud-pgrst@.service", pgrstUnit);
        }

        const gotrueExists = await Bun.file(gotrueUnitPath).exists();
        const currentGotrueUnit = gotrueExists
            ? await Bun.file(gotrueUnitPath).text().catch(() => "")
            : "";
        const shouldWriteGotrueUnit = !gotrueExists
            || !currentGotrueUnit.includes("--config-dir")
            || !currentGotrueUnit.includes("ExecReload=/bin/kill -USR1 $MAINPID")
            || !currentGotrueUnit.includes("User=supacloud-%i")
            || !currentGotrueUnit.includes("Group=supacloud-%i");
        if (shouldWriteGotrueUnit) {
            const gotrueUnit = `
[Unit]
Description=SupaCloud GoTrue for tenant %i
Documentation=https://github.com/supacloud/supacloud
After=network.target patroni.service
Wants=patroni.service

[Service]
Type=simple
User=supacloud-%i
Group=supacloud-%i
EnvironmentFile=${this.TENANT_CONFIG_DIR}/%i_gotrue.env
Environment="GOMEMLIMIT=15MiB"
Environment="GOGC=20"
ExecStart=${this.GOTRUE_BIN} --config-dir ${this.TENANT_CONFIG_DIR}/%i_gotrue.d
ExecReload=/bin/kill -USR1 $MAINPID
Restart=on-failure
RestartSec=5
StartLimitBurst=3
StartLimitIntervalSec=60

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=${this.TENANT_CONFIG_DIR}
MemoryMax=30M
CPUWeight=20

[Install]
WantedBy=multi-user.target
`.trim();
            await installManagedSystemdUnit("supacloud-gotrue@.service", gotrueUnit);
        }

        if (shouldWritePgrstUnit || shouldWriteGotrueUnit) {
            if (systemctlMode === "checked") {
                await runSystemctlOrThrow("daemon-reload");
            } else {
                await $`systemctl daemon-reload`.nothrow().quiet();
            }
            logger.info("systemd template units installed");
        }
    }

    private async ensureAuthSchema(ref: string): Promise<void> {
        const dbName = await resolveDbName(ref);
        const connection = this.adminPsqlConnection(dbName);

        const result = await this.runTenantPsqlOrThrow(
            connection,
            ["-t", "-A", "-c", "SELECT 1 FROM pg_namespace WHERE nspname = 'auth'"],
            "check auth schema",
        );
        const schemaExists = result.stdout.trim() === "1";

        if (!schemaExists) {
            logger.info(`Creating auth schema in tenant database ${dbName}`);
            for (const statement of [
                "CREATE SCHEMA IF NOT EXISTS auth",
                "GRANT ALL ON SCHEMA auth TO supabase_auth_admin",
                "GRANT USAGE ON SCHEMA auth TO authenticated",
                "GRANT USAGE ON SCHEMA auth TO anon",
                "ALTER ROLE supabase_auth_admin SET search_path = auth, public",
            ]) {
                await this.runTenantPsqlOrThrow(connection, ["-v", "ON_ERROR_STOP=1", "-c", statement], "initialize auth schema");
            }
        }

        const usersTableResult = await this.runTenantPsqlOrThrow(
            connection,
            ["-t", "-A", "-c", "SELECT 1 FROM pg_tables WHERE schemaname = 'auth' AND tablename = 'users'"],
            "check auth users table",
        );
        const usersTableExists = usersTableResult.stdout.trim() === "1";

        if (!usersTableExists) {
            logger.info(`Initializing auth schema tables in tenant database ${dbName}`);
            const initSql = `
CREATE TABLE IF NOT EXISTS auth.users (
    instance_id uuid NULL,
    id uuid NOT NULL UNIQUE,
    aud varchar(255) NULL,
    "role" varchar(255) NULL,
    email varchar(255) NULL UNIQUE,
    encrypted_password varchar(255) NULL,
    email_confirmed_at timestamptz NULL,
    invited_at timestamptz NULL,
    confirmation_token varchar(255) NULL,
    confirmation_sent_at timestamptz NULL,
    recovery_token varchar(255) NULL,
    recovery_sent_at timestamptz NULL,
    email_change_token_new varchar(255) NULL DEFAULT '',
    email_change varchar(255) NULL DEFAULT '',
    email_change_sent_at timestamptz NULL,
    last_sign_in_at timestamptz NULL,
    raw_app_meta_data jsonb NULL,
    raw_user_meta_data jsonb NULL,
    is_super_admin bool NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    phone varchar(15) NULL UNIQUE DEFAULT NULL,
    phone_confirmed_at timestamptz NULL DEFAULT NULL,
    phone_change varchar(15) NULL DEFAULT '',
    phone_change_token varchar(255) NULL DEFAULT '',
    phone_change_sent_at timestamptz NULL DEFAULT NULL,
    confirmed_at timestamptz NULL,
    email_change_token_current varchar(255) NULL DEFAULT '',
    email_change_confirm_status smallint DEFAULT 0,
    banned_until timestamptz NULL,
    reauthentication_token varchar(255) NULL DEFAULT '',
    reauthentication_sent_at timestamptz NULL DEFAULT NULL,
    is_anonymous bool NULL DEFAULT FALSE,
    is_sso_user bool NOT NULL DEFAULT FALSE,
    deleted_at timestamptz NULL,
    CONSTRAINT users_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS users_instance_id_email_idx ON auth.users USING btree (instance_id, email);
CREATE INDEX IF NOT EXISTS users_instance_id_idx ON auth.users USING btree (instance_id);

CREATE TABLE IF NOT EXISTS auth.refresh_tokens (
    instance_id uuid NULL,
    id bigserial NOT NULL,
    "token" varchar(255) NULL,
    user_id uuid NULL,
    revoked bool NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    parent varchar(255) NULL,
    session_id uuid NULL,
    CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS refresh_tokens_instance_id_idx ON auth.refresh_tokens USING btree (instance_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_instance_id_user_id_idx ON auth.refresh_tokens USING btree (instance_id, user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_token_idx ON auth.refresh_tokens USING btree (token);

CREATE TABLE IF NOT EXISTS auth.instances (
    id uuid NOT NULL,
    uuid uuid NULL,
    raw_base_config text NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    CONSTRAINT instances_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS auth.audit_log_entries (
    instance_id uuid NULL,
    id uuid NOT NULL,
    payload json NULL,
    created_at timestamptz NULL,
    CONSTRAINT audit_log_entries_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS audit_logs_instance_id_idx ON auth.audit_log_entries USING btree (instance_id);

CREATE TABLE IF NOT EXISTS auth.identities (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    provider_id text NOT NULL,
    provider text NOT NULL,
    identity_data jsonb NOT NULL DEFAULT '{}',
    last_sign_in_at timestamptz NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    CONSTRAINT identities_pkey PRIMARY KEY (id),
    CONSTRAINT identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS identities_user_id_idx ON auth.identities(user_id);

CREATE TABLE IF NOT EXISTS auth.sessions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    CONSTRAINT sessions_pkey PRIMARY KEY (id),
    CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auth.mfa_factors (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    friendly_name text NULL,
    factor_type text NOT NULL,
    status text NOT NULL,
    secret text NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    CONSTRAINT mfa_factors_pkey PRIMARY KEY (id),
    CONSTRAINT mfa_factors_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auth.mfa_challenges (
    id uuid NOT NULL,
    factor_id uuid NOT NULL,
    created_at timestamptz NULL,
    verified_at timestamptz NULL,
    ip_address inet NULL,
    CONSTRAINT mfa_challenges_pkey PRIMARY KEY (id),
    CONSTRAINT mfa_challenges_factor_id_fkey FOREIGN KEY (factor_id) REFERENCES auth.mfa_factors(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auth.flow_state (
    id uuid NOT NULL,
    user_id uuid NULL,
    auth_code varchar(255) NULL,
    code_challenge_method varchar(255) NULL,
    code_challenge varchar(255) NULL,
    provider_type text NOT NULL,
    provider_access_token text NULL,
    provider_refresh_token text NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    authentication_method text NOT NULL,
    CONSTRAINT flow_state_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS auth.sso_providers (
    id uuid NOT NULL,
    resource_id text NULL,
    created_at timestamptz NULL,
    updated_at timestamptz NULL,
    CONSTRAINT sso_providers_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS auth.sso_domains (
    id uuid NOT NULL,
    sso_provider_id uuid NOT NULL,
    domain text NOT NULL,
    created_at timestamptz NULL,
    CONSTRAINT sso_domains_pkey PRIMARY KEY (id),
    CONSTRAINT sso_domains_sso_provider_id_fkey FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auth.schema_migrations (
    "version" varchar(255) NOT NULL,
    CONSTRAINT schema_migrations_pkey PRIMARY KEY ("version")
);

DO $$ BEGIN
  CREATE TYPE auth.one_time_token_type AS ENUM (
    'confirmation_token',
    'reauthentication_token',
    'recovery_token',
    'email_change_token_new',
    'email_change_token_current',
    'phone_change_token'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS auth.one_time_tokens (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
    token_type auth.one_time_token_type NOT NULL,
    token_hash TEXT NOT NULL,
    relates_to TEXT NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    CHECK (char_length(token_hash) > 0)
);
CREATE INDEX IF NOT EXISTS one_time_tokens_token_hash_hash_idx ON auth.one_time_tokens USING hash (token_hash);
CREATE INDEX IF NOT EXISTS one_time_tokens_relates_to_hash_idx ON auth.one_time_tokens USING hash (relates_to);
CREATE UNIQUE INDEX IF NOT EXISTS one_time_tokens_user_id_token_type_key ON auth.one_time_tokens (user_id, token_type);

CREATE SCHEMA IF NOT EXISTS graphql_public;
GRANT USAGE ON SCHEMA graphql_public TO anon, authenticated, service_role;

DO $graphql_fallback$
BEGIN
  IF to_regprocedure('graphql_public.graphql(text,text,jsonb,jsonb)') IS NULL
     AND to_regprocedure('graphql_public.graphql(text,text,jsonb)') IS NULL THEN
    EXECUTE $fn$
      CREATE FUNCTION graphql_public.graphql(
        "operationName" text DEFAULT NULL,
        query text DEFAULT NULL,
        variables jsonb DEFAULT NULL,
        extensions jsonb DEFAULT NULL
      )
      RETURNS jsonb
      LANGUAGE plpgsql
      STABLE
      AS $body$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_graphql') THEN
          RETURN jsonb_build_object(
            'errors', jsonb_build_array(
              jsonb_build_object(
                'message', 'pg_graphql is installed but the graphql function was not properly created. Re-run: CREATE EXTENSION pg_graphql CASCADE;'
              )
            )
          );
        END IF;

        RETURN jsonb_build_object(
          'errors', jsonb_build_array(
            jsonb_build_object(
              'message', 'GraphQL is not available on this project. The pg_graphql PostgreSQL extension is not installed on the host cluster.'
            )
          )
        );
      END;
      $body$;
    $fn$;
  END IF;

  IF to_regprocedure('graphql_public.graphql(text,text,jsonb,jsonb)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION graphql_public.graphql(text,text,jsonb,jsonb) TO anon, authenticated, service_role';
  ELSIF to_regprocedure('graphql_public.graphql(text,text,jsonb)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION graphql_public.graphql(text,text,jsonb) TO anon, authenticated, service_role';
  END IF;
END;
$graphql_fallback$;

${SQL_MODULES["auth-jwt-helpers"]}

GRANT ALL ON ALL TABLES IN SCHEMA auth TO supabase_auth_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA auth TO supabase_auth_admin;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT USAGE ON SCHEMA auth TO anon;

INSERT INTO auth.schema_migrations (version) VALUES
    ('00'), ('20210710035447'), ('20210722035447'), ('20210730183235'),
    ('20210909172000'), ('20210927181326'), ('20211122151130'), ('20211124214934'),
    ('20211202183645'), ('20220114185221'), ('20220114185340'), ('20220224000811'),
    ('20220323170000'), ('20220429102000'), ('20220531120530'), ('20220614074123'),
    ('20220811173540'), ('20221003041449'), ('20221007042446'), ('20221020192200'),
    ('20221027105044'), ('20221114183602'), ('20221114183603'), ('20221215193445'),
    ('20230114183602'), ('20230114183603'), ('20230207200153'), ('20230216171608'),
    ('20230417165000'), ('20230526153447'), ('20230529173540'), ('20230710143444'),
    ('20230725155344'), ('20230815173540'), ('20230817143444'), ('20230914161444'),
    ('20231016084244'), ('20231020155344'), ('20231113183444'), ('20231116155344'),
    ('20231201155344'), ('20231208084244'), ('20240313155344'), ('20240417163444'),
    ('20240429155344'), ('20240604084244')
ON CONFLICT DO NOTHING;
`.trim();
            const temporary = await this.writeTemporaryTenantSql(ref, "auth-schema-init", initSql);
            try {
                await this.runTenantPsqlOrThrow(
                    connection,
                    ["-v", "ON_ERROR_STOP=1", "-f", temporary.file],
                    "initialize auth tables",
                );
            } finally {
                await fs.rm(temporary.directory, { recursive: true, force: true });
            }
        }
    }

    private async ensureOneTimeTokensAndGraphQL(ref: string): Promise<void> {
        // Error contract: `-v ON_ERROR_STOP=1` is passed as a structured arg and
        // runTenantPsqlOrThrow performs `throw new Error(`psql exited with code ...`)`.
        const dbName = await resolveDbName(ref);
        const connection = this.adminPsqlConnection(dbName);

        const migrationSql = `
DO $$ BEGIN
  CREATE TYPE auth.one_time_token_type AS ENUM (
    'confirmation_token',
    'reauthentication_token',
    'recovery_token',
    'email_change_token_new',
    'email_change_token_current',
    'phone_change_token'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS auth.one_time_tokens (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
    token_type auth.one_time_token_type NOT NULL,
    token_hash TEXT NOT NULL,
    relates_to TEXT NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    CHECK (char_length(token_hash) > 0)
);

DO $$ BEGIN ALTER TABLE auth.one_time_tokens ADD COLUMN IF NOT EXISTS user_id UUID; EXCEPTION WHEN duplicate_column THEN NULL; END $$;

UPDATE auth.one_time_tokens t
SET user_id = u.id
FROM auth.users u
WHERE t.user_id IS NULL
  AND u.email = t.relates_to;

DELETE FROM auth.one_time_tokens WHERE user_id IS NULL;

DO $$ BEGIN
  ALTER TABLE auth.one_time_tokens ALTER COLUMN user_id SET NOT NULL;
EXCEPTION WHEN others THEN NULL; END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'auth.one_time_tokens'::regclass
      AND c.confrelid = 'auth.users'::regclass
      AND c.contype = 'f'
      AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'auth.one_time_tokens'::regclass AND attname = 'user_id')]
      AND c.confkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'auth.users'::regclass AND attname = 'id')]
  ) THEN
    ALTER TABLE auth.one_time_tokens
      ADD CONSTRAINT one_time_tokens_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS one_time_tokens_token_hash_hash_idx ON auth.one_time_tokens USING hash (token_hash);
CREATE INDEX IF NOT EXISTS one_time_tokens_relates_to_hash_idx ON auth.one_time_tokens USING hash (relates_to);
CREATE UNIQUE INDEX IF NOT EXISTS one_time_tokens_user_id_token_type_key ON auth.one_time_tokens (user_id, token_type);

CREATE SCHEMA IF NOT EXISTS graphql_public;
GRANT USAGE ON SCHEMA graphql_public TO anon, authenticated, service_role;

DO $graphql_fallback$
BEGIN
  IF to_regprocedure('graphql_public.graphql(text,text,jsonb,jsonb)') IS NULL
     AND to_regprocedure('graphql_public.graphql(text,text,jsonb)') IS NULL THEN
    EXECUTE $fn$
      CREATE FUNCTION graphql_public.graphql(
        "operationName" text DEFAULT NULL,
        query text DEFAULT NULL,
        variables jsonb DEFAULT NULL,
        extensions jsonb DEFAULT NULL
      )
      RETURNS jsonb
      LANGUAGE plpgsql
      STABLE
      AS $body$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_graphql') THEN
          RETURN jsonb_build_object(
            'errors', jsonb_build_array(
              jsonb_build_object(
                'message', 'pg_graphql is installed but the graphql function was not properly created. Re-run: CREATE EXTENSION pg_graphql CASCADE;'
              )
            )
          );
        END IF;

        RETURN jsonb_build_object(
          'errors', jsonb_build_array(
            jsonb_build_object(
              'message', 'GraphQL is not available on this project. The pg_graphql PostgreSQL extension is not installed on the host cluster.'
            )
          )
        );
      END;
      $body$;
    $fn$;
  END IF;

  IF to_regprocedure('graphql_public.graphql(text,text,jsonb,jsonb)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION graphql_public.graphql(text,text,jsonb,jsonb) TO anon, authenticated, service_role';
  ELSIF to_regprocedure('graphql_public.graphql(text,text,jsonb)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION graphql_public.graphql(text,text,jsonb) TO anon, authenticated, service_role';
  END IF;
END;
$graphql_fallback$;

${SQL_MODULES["pgmq-public"]}
`.trim();
        const temporary = await this.writeTemporaryTenantSql(ref, "ott-graphql-migration", migrationSql);
        try {
            await this.runTenantPsqlOrThrow(
                connection,
                ["-v", "ON_ERROR_STOP=1", "-f", temporary.file],
                "ensure one_time_tokens and graphql_public",
            );
            logger.info(`[tenant-runtime] Ensured one_time_tokens + graphql_public.graphql() for ${ref}`);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`[tenant-runtime] one_time_tokens/graphql migration error for ${ref}: ${msg}`);
            throw error;
        } finally {
            await fs.rm(temporary.directory, { recursive: true, force: true }).catch(() => {});
        }
    }

    private async ensurePostgrestPrerequest(
        ref: string,
        thirdPartyPolicy: ThirdPartyJwtPolicy | null,
        localJwtIssuer: string | null,
    ): Promise<void> {
        // Error contract: `-v ON_ERROR_STOP=1` is passed as a structured arg and
        // runTenantPsqlOrThrow performs `throw new Error(`psql exited with code ...`)`.
        const dbName = await resolveDbName(ref);
        const connection = this.adminPsqlConnection(dbName);
        const supauthIssuer = await this.sharedAuthIssuer(ref);
        const issuerLiteral = supauthIssuer ? quoteSqlLiteral(supauthIssuer) : "NULL";
        const thirdPartyIssuerBranch = thirdPartyPolicy
            ? `ELSIF claims ->> 'iss' = ${quoteSqlLiteral(thirdPartyPolicy.issuer)} THEN\n    NULL;`
            : "";
        const sharedAuthGuard = supauthIssuer
            ? `
  IF claims ->> 'iss' = ${issuerLiteral} THEN
    IF role_claim <> 'authenticated' THEN
      RAISE insufficient_privilege USING MESSAGE = 'SupAuth owner tokens may only use the authenticated role';
    END IF;
  ${thirdPartyIssuerBranch}
  ELSIF claims ->> 'iss' = 'supabase' THEN
    IF role_claim NOT IN ('anon', 'service_role') THEN
      RAISE insufficient_privilege USING MESSAGE = 'Dependent legacy user sessions are disabled while SupAuth is active';
    END IF;
  ELSE
    RAISE insufficient_privilege USING MESSAGE = 'JWT issuer is not allowed for this SupAuth dependent project';
  END IF;
`
            : "";

        const thirdPartyGate = thirdPartyPolicy
            ? `
  issuer_claim := claims ->> 'iss';
  client_id_claim := claims ->> 'client_id';
  audience_matches := CASE
    WHEN jsonb_typeof(claims -> 'aud') = 'string'
      THEN claims ->> 'aud' = ${quoteSqlLiteral(thirdPartyPolicy.audience[0])}
    WHEN jsonb_typeof(claims -> 'aud') = 'array'
      THEN (claims -> 'aud') ? ${quoteSqlLiteral(thirdPartyPolicy.audience[0])}
    ELSE false
  END;

  IF issuer_claim = ${quoteSqlLiteral(thirdPartyPolicy.issuer)}
     OR (
       client_id_claim IS NOT NULL
       AND ${localJwtIssuer
           ? `issuer_claim IS DISTINCT FROM ${quoteSqlLiteral(localJwtIssuer)}`
           : "true"}
     ) THEN
    IF issuer_claim IS DISTINCT FROM ${quoteSqlLiteral(thirdPartyPolicy.issuer)}
       OR client_id_claim IS DISTINCT FROM ${quoteSqlLiteral(thirdPartyPolicy.clientId)}
       OR role_claim IS DISTINCT FROM 'authenticated'
       OR NOT audience_matches THEN
      RAISE EXCEPTION USING
        ERRCODE = '28000',
        MESSAGE = 'third-party JWT claims rejected';
    END IF;
  END IF;
`.trimEnd()
            : "";

        const fnSql = `
CREATE OR REPLACE FUNCTION public.set_request_context() RETURNS void AS $$
DECLARE
  claims jsonb;
  role_claim text;
  issuer_claim text;
  client_id_claim text;
  audience_matches boolean := false;
BEGIN
  BEGIN
    claims := COALESCE(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb,
      '{}'::jsonb
    );
  EXCEPTION WHEN invalid_text_representation THEN
    claims := '{}'::jsonb;
  END;

  role_claim := COALESCE(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    claims ->> 'role',
    'anon'
  );

${thirdPartyGate}

${sharedAuthGuard}
  PERFORM set_config('request.jwt.claims', claims::text, true);
  PERFORM set_config('request.jwt.claim.sub', coalesce(claims ->> 'sub', ''), true);
  PERFORM set_config('request.jwt.claim.email', coalesce(claims ->> 'email', ''), true);
  PERFORM set_config('request.jwt.claim.role', role_claim, true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog;
`.trim();
        const temporary = await this.writeTemporaryTenantSql(ref, "pgrst-prerequest", fnSql);
        try {
            await this.runTenantPsqlOrThrow(
                connection,
                ["-v", "ON_ERROR_STOP=1", "-f", temporary.file],
                "ensure PostgREST pre-request function",
            );
            logger.info(`[tenant-runtime] Ensured public.set_request_context() for ${ref}`);
        } finally {
            await fs.rm(temporary.directory, { recursive: true, force: true });
        }
    }

    public async startRuntime(ref: string): Promise<RuntimeStatus> {
        await this.ensureBinaries();
        await this.ensureAuthSchema(ref);
        await this.ensureOneTimeTokensAndGraphQL(ref);
        await this.ensureTenantSchemaMigrations(ref);
        const jwtPolicy = await this.getTenantCredentials(ref);
        await this.ensurePostgrestPrerequest(
            ref,
            jwtPolicy.thirdPartyJwtPolicy,
            jwtPolicy.localJwtIssuer,
        );

        const pgrstPort = await this.getTenantPort(ref, "pgrst");
        const gotruePort = await this.getTenantPort(ref, "gotrue");
        const pgrstStatus = await this.activatePostgrestGeneration(ref, "ensure-running");
        if (!pgrstStatus) throw new Error(`PostgREST activation did not run for ${ref}`);

        if (!isSharedAuthRuntime(ref)) {
            await this.gotrueController.enable(ref);
            await this.gotrueController.start(ref);
        }

        // Wait for service health checks
        logger.info(`Waiting for PostgREST(${pgrstPort}) and GoTrue(${gotruePort}) health checks...`);
        let pgrstOk = pgrstStatus.health === "healthy";
        let gotrueOk = false;

        for (let tryIdx = 0; tryIdx < 20; tryIdx++) {
            if (!pgrstOk) {
                const status = await this.postgrestController.observe(ref, pgrstPort);
                pgrstOk = status.health === "healthy";
            }

            if (!gotrueOk && !isSharedAuthRuntime(ref)) {
                try {
                    const res = await fetch(`http://127.0.0.1:${gotruePort}/health`);
                    if (res.ok) gotrueOk = true;
                } catch (e: unknown) { logger.debug("[services/tenant-runtime.service] suppressed error", { error: e instanceof Error ? e.message : String(e) }); }
            }

            if (pgrstOk && (gotrueOk || isSharedAuthRuntime(ref))) {
                await this.setPostgrestDesiredState(ref, "running");
                await this.recordPostgrestObservation(ref, {
                    actual: "running",
                    health: "healthy",
                    port: pgrstPort,
                    last_error: null,
                });
                return { status: "running", port: pgrstPort, gotruePort, health: "healthy" };
            }
            await Bun.sleep(1000);
        }

        logger.warn("WARNING: Health check timeout, some services may still be starting");
        await this.setPostgrestDesiredState(ref, "running");
        await this.recordPostgrestObservation(ref, {
            actual: pgrstOk ? "running" : "starting",
            health: pgrstOk ? "healthy" : "unhealthy",
            port: pgrstPort,
            last_error: pgrstOk ? null : "PostgREST health check timeout during runtime start",
        });
        return { status: "starting", port: pgrstPort, gotruePort, health: "degraded" };
    }

    private async stopRuntimeUnits(ref: string): Promise<void> {
        await this.postgrestController.stopAndDisable(ref);

        await this.gotrueController.stopAndDisable(ref);

    }

    private async removeRuntimeConfig(ref: string): Promise<void> {
        const pgrstEnvFile = Bun.file(path.join(this.TENANT_CONFIG_DIR, `${ref}.env`));
        const pgrstConfFile = Bun.file(path.join(this.TENANT_CONFIG_DIR, `${ref}.conf`));
        const pgrstPointerFile = Bun.file(path.join(this.TENANT_CONFIG_DIR, `${ref}_postgrest.current`));
        const pgrstGenerationDirectory = path.join(this.TENANT_CONFIG_DIR, `${ref}_postgrest.d`);
        const gotrueEnvFile = Bun.file(path.join(this.TENANT_CONFIG_DIR, `${ref}_gotrue.env`));
        const pgredisEnvFile = Bun.file(path.join(this.PGREDIS_CONFIG_DIR, `${ref}_pgredis.env`));
        const gotrueConfigDir = path.join(this.TENANT_CONFIG_DIR, `${ref}_gotrue.d`);

        if (await pgrstEnvFile.exists()) await fs.unlink(pgrstEnvFile.name!);
        if (await pgrstConfFile.exists()) await fs.unlink(pgrstConfFile.name!);
        if (await pgrstPointerFile.exists()) await fs.unlink(pgrstPointerFile.name!);
        await fs.rm(pgrstGenerationDirectory, { recursive: true, force: true });
        if (await gotrueEnvFile.exists()) await fs.unlink(gotrueEnvFile.name!);
        if (await pgredisEnvFile.exists()) await fs.unlink(pgredisEnvFile.name!);
        await fs.rm(gotrueConfigDir, { recursive: true, force: true });
    }

    private getPostgrestDesiredState(project: { status?: unknown; postgrest_desired?: unknown }): RuntimeDesiredState {
        const desired = (project as Record<string, unknown>).postgrest_desired;
        if (desired === "running" || desired === "stopped") {
            return desired;
        }
        return String(project.status || "").toLowerCase() === "active" ? "running" : "stopped";
    }

    private async setPostgrestDesiredState(ref: string, desired: RuntimeDesiredState): Promise<void> {
        await metaSql`
          UPDATE projects
          SET postgrest_desired = ${desired},
              postgrest_updated_at = NOW(),
              updated_at = NOW()
          WHERE ref = ${ref} AND deleted_at IS NULL
        `;
    }

    private async recordPostgrestObservation(
        ref: string,
        status: Pick<PostgrestRuntimeStatus, "actual" | "health" | "port" | "last_error">,
        opts: { reconciled?: boolean } = {},
    ): Promise<void> {
        await metaSql`
          UPDATE projects
          SET postgrest_actual = ${status.actual},
              postgrest_health = ${status.health},
              postgrest_port = ${status.port},
              postgrest_last_error = ${status.last_error},
              postgrest_updated_at = NOW(),
              postgrest_last_reconciled_at = CASE
                WHEN ${opts.reconciled === true} THEN NOW()
                ELSE postgrest_last_reconciled_at
              END,
              updated_at = NOW()
          WHERE ref = ${ref} AND deleted_at IS NULL
        `;
    }

    private async recordPostgrestFailure(
        ref: string,
        error: unknown,
        opts: { reconciled?: boolean } = {},
    ): Promise<void> {
        const message = error instanceof Error ? error.message : String(error);
        await metaSql`
          UPDATE projects
          SET postgrest_actual = 'error',
              postgrest_health = 'unhealthy',
              postgrest_last_error = ${message},
              postgrest_updated_at = NOW(),
              postgrest_last_reconciled_at = CASE
                WHEN ${opts.reconciled === true} THEN NOW()
                ELSE postgrest_last_reconciled_at
              END,
              updated_at = NOW()
          WHERE ref = ${ref} AND deleted_at IS NULL
        `;
    }

    private async readPostgrestRuntimeStatus(ref: string, opts: { persistObservation?: boolean } = {}): Promise<PostgrestRuntimeStatus> {
        const [project] = await metaSql`
          SELECT status,
                 postgrest_desired,
                 postgrest_actual,
                 postgrest_health,
                 postgrest_port,
                 postgrest_last_error,
                 postgrest_updated_at,
                 postgrest_last_reconciled_at,
                 updated_at
          FROM projects
          WHERE ref = ${ref} AND deleted_at IS NULL
          LIMIT 1
        `;

        const desired = this.getPostgrestDesiredState({
            status: project?.status,
            postgrest_desired: project?.postgrest_desired,
        });
        const port = await this.getTenantPort(ref, "pgrst");
        const observation = await this.postgrestController.observe(ref, port);
        const observedError = observation.last_error ??
            (typeof project?.postgrest_last_error === "string" ? project.postgrest_last_error : null);

        const status: PostgrestRuntimeStatus = {
            component: "postgrest",
            desired,
            actual: observation.actual,
            port,
            unit: this.postgrestController.unit(ref),
            health: observation.health,
            last_error: observedError,
            updated_at: project?.postgrest_updated_at
                ? new Date(project.postgrest_updated_at).toISOString()
                : (project?.updated_at ? new Date(project.updated_at).toISOString() : null),
            last_reconciled_at: project?.postgrest_last_reconciled_at
                ? new Date(project.postgrest_last_reconciled_at).toISOString()
                : null,
        };

        if (opts.persistObservation) {
            await this.recordPostgrestObservation(ref, status);
        }

        return status;
    }

    private async preparePostgrestRuntime(ref: string): Promise<void> {
        await this.ensurePostgrestBinary();
        await this.installSystemdTemplate("checked");
        await this.ensureTenantSchemaMigrations(ref);
        const jwtPolicy = await this.getTenantCredentials(ref);
        await this.ensurePostgrestPrerequest(
            ref,
            jwtPolicy.thirdPartyJwtPolicy,
            jwtPolicy.localJwtIssuer,
        );
    }

    private async persistPostgrestObservation(
        ref: string,
        status: PostgrestRuntimeStatus,
        fallbackError: string | null,
    ): Promise<void> {
        await this.recordPostgrestObservation(ref, {
            actual: status.actual,
            health: status.health,
            port: status.port,
            last_error: status.health === "healthy" || status.actual === "stopped"
                ? null
                : status.last_error || fallbackError,
        });
    }

    private async persistPostgrestFailure(ref: string, error: unknown): Promise<void> {
        await this.recordPostgrestFailure(ref, error);
    }

    private async startPreparedPostgrest(ref: string, mode: "restart" | "repair"): Promise<PostgrestRuntimeStatus> {
        const status = await this.activatePostgrestGeneration(
            ref,
            mode === "restart" ? "restart-running" : "ensure-running",
        );
        if (!status) throw new Error(`PostgREST activation did not run for ${ref}`);
        return status;
    }

    private async transitionPostgrest(
        ref: string,
        opts: {
            desired: RuntimeDesiredState;
            mode?: "restart" | "repair";
            logVerb: "paused" | "resumed" | "restarted";
            fallbackError: string;
        },
    ): Promise<PostgrestRuntimeStatus> {
        await this.setPostgrestDesiredState(ref, opts.desired);

        try {
            const status = opts.desired === "stopped"
                ? await (async () => {
                    await this.postgrestController.stopAndDisable(ref);
                    return this.readPostgrestRuntimeStatus(ref);
                })()
                : await (async () => {
                    await this.preparePostgrestRuntime(ref);
                    return this.startPreparedPostgrest(ref, opts.mode || "repair");
                })();

            await this.persistPostgrestObservation(ref, status, opts.fallbackError);
            logger.info(`PostgREST ${opts.logVerb} for ${ref}`);
            return this.readPostgrestRuntimeStatus(ref);
        } catch (error: unknown) {
            await this.persistPostgrestFailure(ref, error);
            throw error;
        }
    }

    public async pauseProjectRuntime(ref: string): Promise<void> {
        await this.stopRuntimeUnits(ref);
        await this.setPostgrestDesiredState(ref, "stopped");
        await this.recordPostgrestObservation(ref, {
            actual: "stopped",
            health: "unknown",
            port: await this.getTenantPort(ref, "pgrst"),
            last_error: null,
        });
        logger.info(`Runtime paused for ${ref}`);
    }

    public async resumeProjectRuntime(ref: string): Promise<RuntimeStatus> {
        return this.startRuntime(ref);
    }


    private async ensureTenantSchemaMigrations(ref: string): Promise<void> {
        // This replaces `Bun.write(tmpFile, ALTER_TENANT_SQL)` with a unique 0600 file.
        // Error contract: `-v ON_ERROR_STOP=1`; runTenantPsqlOrThrow performs
        // `throw new Error(`psql exited with code ...`)` without placing secrets in argv.
        const dbName = await resolveDbName(ref);
        const connection = this.adminPsqlConnection(dbName);
        const temporary = await this.writeTemporaryTenantSql(ref, "tenant-schema-migration", ALTER_TENANT_SQL);

        try {
            await this.runTenantPsqlOrThrow(
                connection,
                ["-v", "ON_ERROR_STOP=1", "-f", temporary.file],
                "ensure tenant schema migrations",
            );
            logger.info(`[tenant-runtime] Ensured tenant schema migrations for ${ref}`);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`[tenant-runtime] Tenant schema migration error for ${ref}: ${msg}`);
            throw error;
        } finally {
            await fs.rm(temporary.directory, { recursive: true, force: true }).catch(() => {});
        }
    }

    public async stopRuntime(ref: string): Promise<void> {
        await this.stopRuntimeUnits(ref);
        await this.removeRuntimeConfig(ref);
        await this.setPostgrestDesiredState(ref, "stopped");
        await this.recordPostgrestObservation(ref, {
            actual: "stopped",
            health: "unknown",
            port: await this.getTenantPort(ref, "pgrst"),
            last_error: null,
        });

        logger.info(`Runtime stopped for ${ref}`);
    }

    public async pausePostgrest(ref: string): Promise<PostgrestRuntimeStatus> {
        return this.transitionPostgrest(ref, {
            desired: "stopped",
            logVerb: "paused",
            fallbackError: "PostgREST did not stop after pause request",
        });
    }

    public async resumePostgrest(ref: string): Promise<PostgrestRuntimeStatus> {
        return this.transitionPostgrest(ref, {
            desired: "running",
            mode: "repair",
            logVerb: "resumed",
            fallbackError: "PostgREST health check did not become healthy",
        });
    }

    public async restartPostgrest(ref: string): Promise<PostgrestRuntimeStatus> {
        return this.transitionPostgrest(ref, {
            desired: "running",
            mode: "restart",
            logVerb: "restarted",
            fallbackError: "PostgREST health check did not become healthy",
        });
    }

    public async statusPostgrest(ref: string): Promise<PostgrestRuntimeStatus> {
        return this.readPostgrestRuntimeStatus(ref, { persistObservation: true });
    }

    private mapPostgrestServiceStatus(
        ref: string,
        runtime: PostgrestRuntimeStatus,
        opts: { id: string; name: string },
    ): ProjectServiceStatus {
        const serviceStatus =
            runtime.health === "healthy"
                ? "ACTIVE_HEALTHY"
                : runtime.actual === "starting"
                    ? "COMING_UP"
                    : "UNHEALTHY";

        return {
            id: opts.id,
            name: opts.name,
            status: serviceStatus,
            healthy: serviceStatus === "ACTIVE_HEALTHY",
            service_host_ids: [`${ref}-${opts.id}`],
            component: "postgrest",
            desired_state: runtime.desired,
            actual_state: runtime.actual,
            health: runtime.health,
            port: runtime.port,
            unit: runtime.unit,
            last_error: runtime.last_error,
            updated_at: runtime.updated_at,
            last_reconciled_at: runtime.last_reconciled_at,
        };
    }

    private unhealthyService(ref: string, id: string, name: string): ProjectServiceStatus {
        return {
            id,
            name,
            status: "UNHEALTHY",
            healthy: false,
            service_host_ids: [`${ref}-${id}`],
        };
    }

    private async checkSystemService(unitName: string): Promise<string> {
        try {
            const result = await $`systemctl is-active ${unitName} 2>/dev/null`.nothrow().quiet();
            return result.exitCode === 0 ? "ACTIVE_HEALTHY" : "INACTIVE";
        } catch {
            return "INACTIVE";
        }
    }

    private async checkContainerService(containerName: string): Promise<string> {
        try {
            const result = await $`docker inspect -f '{{.State.Status}}' ${containerName} 2>/dev/null || podman inspect -f '{{.State.Status}}' ${containerName} 2>/dev/null`
                .nothrow()
                .quiet();
            return result.text().trim() === "running" ? "ACTIVE_HEALTHY" : "INACTIVE";
        } catch {
            return "INACTIVE";
        }
    }

    /** Check DB health: try systemd first, then SQL probe as fallback */
    private async checkDbHealth(ref: string): Promise<string> {
        const systemdResult = await this.checkSystemService("patroni");
        if (systemdResult === "ACTIVE_HEALTHY") return "ACTIVE_HEALTHY";
        // Fallback: try a lightweight SQL query on the meta database
        try {
            await metaSql`SELECT 1`;
            return "ACTIVE_HEALTHY";
        } catch {
            return "INACTIVE";
        }
    }

    /** Check storage health: try systemd first, then S3 endpoint as fallback */
    private async checkStorageHealth(): Promise<string> {
        const systemdResult = await this.checkSystemService("supacloud-storage");
        if (systemdResult === "ACTIVE_HEALTHY") return "ACTIVE_HEALTHY";
        // Fallback: probe the S3 health endpoint (accept any response, not just 2xx)
        try {
            const res = await fetch(`${config.s3Endpoint}/minio/health/live`, {
                signal: AbortSignal.timeout(3000),
            });
            // Any response (even 4xx) means the storage service is reachable
            return "ACTIVE_HEALTHY";
        } catch { /* ignore */ }
        // Final fallback: for juicefs mode, check the mount directory
        if (config.storageType === "juicefs") {
            try {
                const result = await $`test -d /var/lib/juicefs`.nothrow().quiet();
                if (result.exitCode === 0) return "ACTIVE_HEALTHY";
            } catch { /* ignore */ }
        }
        return "INACTIVE";
    }

    /** Check Realtime health: prefer systemd, then container HTTP healthcheck fallback */
    private async checkRealtimeHealth(): Promise<string> {
        const systemdResult = await this.checkSystemService("supacloud-realtime");
        if (systemdResult === "ACTIVE_HEALTHY") return "ACTIVE_HEALTHY";

        try {
            const healthUrl = new URL("/healthcheck", config.realtimeAdminUrl);
            const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
            if (res.status < 500) return "ACTIVE_HEALTHY";
        } catch { /* ignore */ }

        return "INACTIVE";
    }

    private systemServiceEntry(ref: string, id: string, name: string, status: string): ProjectServiceStatus {
        const normalized = status === "ACTIVE_HEALTHY" ? "ACTIVE_HEALTHY" : status === "COMING_UP" ? "COMING_UP" : "UNHEALTHY";
        return {
            id,
            name,
            status: normalized,
            healthy: normalized === "ACTIVE_HEALTHY",
            service_host_ids: [`${ref}-${id}`],
        };
    }

    public async getProjectServiceStatuses(
        ref: string,
        projectConfig: unknown,
        mode: "studio" | "detail" = "studio",
    ): Promise<ProjectServiceStatus[]> {
        const authRuntime = getAuthRuntimeDescriptor(ref);
        const authRuntimeRef = authRuntime.authority_project_ref;
        const serviceDefs = mode === "studio"
            ? [
                { id: "db", name: "db", unit: "patroni" },
                { id: "auth", name: "auth", unit: `supacloud-gotrue@${authRuntimeRef}` },
                { id: "realtime", name: "realtime", unit: "supacloud-realtime", container: "supacloud-realtime" },
                { id: "storage", name: "storage", unit: "supacloud-storage" },
            ]
            : [
                { id: "postgresql", name: "PostgreSQL", unit: "patroni" },
                { id: "gotrue", name: "GoTrue", unit: `supacloud-gotrue@${authRuntimeRef}` },
                { id: "realtime", name: "Realtime", unit: "supacloud-realtime", container: "supacloud-realtime" },
                { id: "storage", name: "Storage", unit: "supacloud-storage" },
                {
                    id: "caddy",
                    name: "Caddy",
                    unit: "supacloud-caddy",
                },
            ];

        const [postgrest, dbHealth, storageHealth, ...otherSystemResults] = await Promise.allSettled([
            this.readPostgrestRuntimeStatus(ref),
            this.checkDbHealth(ref),
            this.checkStorageHealth(),
            ...serviceDefs.filter(s => s.id !== "db" && s.id !== "storage" && s.id !== "postgresql")
                .map(async (service) => {
                    const systemdStatus = await this.checkSystemService(service.unit);
                    if (service.id === "realtime") {
                        const realtimeStatus = await this.checkRealtimeHealth();
                        if (realtimeStatus === "ACTIVE_HEALTHY") return realtimeStatus;
                    }
                    const containerName = "container" in service ? service.container : undefined;
                    if (systemdStatus === "ACTIVE_HEALTHY" || typeof containerName !== "string") {
                        return systemdStatus;
                    }
                    return this.checkContainerService(containerName);
                }),
        ]);

        const restId = mode === "studio" ? "rest" : "postgrest";
        const restName = mode === "studio" ? "rest" : "PostgREST";
        const postgrestEntry = postgrest.status === "fulfilled"
            ? this.mapPostgrestServiceStatus(ref, postgrest.value, { id: restId, name: restName })
            : {
                ...this.unhealthyService(ref, restId, restName),
                component: "postgrest" as const,
            };

        const dbStatus = dbHealth.status === "fulfilled" ? dbHealth.value : "INACTIVE";
        const storageStatus = storageHealth.status === "fulfilled" ? storageHealth.value : "INACTIVE";
        const otherEntries = serviceDefs
            .filter(s => s.id !== "db" && s.id !== "storage" && s.id !== "postgresql")
            .map((service, idx) => {
                const result = otherSystemResults[idx];
                const serviceStatus = result?.status === "fulfilled" ? result.value : "INACTIVE";
                return this.systemServiceEntry(ref, service.id, service.name, serviceStatus);
            });
        const [rawAuthCandidate, ...remainingEntries] = otherEntries;
        const authId = mode === "studio" ? "auth" : "gotrue";
        const authName = mode === "studio" ? "auth" : "GoTrue";
        const rawAuth = rawAuthCandidate ?? this.unhealthyService(ref, authId, authName);
        const authEntry = projectAuthServiceEntry(rawAuth, authRuntime, projectConfig);

        if (mode === "studio") {
            const db = this.systemServiceEntry(ref, "db", "db", dbStatus);
            const storage = this.systemServiceEntry(ref, "storage", "storage", storageStatus);
            const [realtime] = remainingEntries;
            return [db, postgrestEntry, authEntry, realtime, storage];
        }

        const postgresql = this.systemServiceEntry(ref, "postgresql", "PostgreSQL", dbStatus);
        const storage = this.systemServiceEntry(ref, "storage", "Storage", storageStatus);
        const [realtime, gateway] = remainingEntries;
        return [postgresql, postgrestEntry, authEntry, realtime, storage, gateway];
    }

    public async restartRuntime(ref: string): Promise<RuntimeStatus> {
        const pgrstActive = await this.postgrestController.isActive(ref);
        const gotrueActive = await this.gotrueController.isActive(ref);
        const sharedAuthRuntime = isSharedAuthRuntime(ref);

        if (pgrstActive || gotrueActive) {
            await this.ensureBinaries();
            const postgrestStatus = await this.activatePostgrestGeneration(ref, "restart-running");
            if (!postgrestStatus) throw new Error(`PostgREST activation did not run for ${ref}`);
            if (sharedAuthRuntime) await this.gotrueController.stopAndDisable(ref);
            else await this.gotrueController.restart(ref);

            await this.setPostgrestDesiredState(ref, "running");
            await this.recordPostgrestObservation(ref, {
                actual: postgrestStatus.actual,
                health: postgrestStatus.health,
                port: postgrestStatus.port,
                last_error: postgrestStatus.health === "healthy" ? null : "PostgREST health check did not become healthy after runtime restart",
            });
            const status = await this.checkStatus(ref);
            if (!sharedAuthRuntime && getAuthRuntimeDescriptor(ref).mode === "owner") {
                await this.refreshSharedAuthDependents(ref);
            }
            return status;
        } else {
            const status = await this.startRuntime(ref);
            if (!sharedAuthRuntime && getAuthRuntimeDescriptor(ref).mode === "owner") {
                await this.refreshSharedAuthDependents(ref);
            }
            return status;
        }
    }

    private async applyGotrueAuthConfig(ref: string): Promise<AppliedGotrueAuthConfig> {
        const authRuntime = getAuthRuntimeDescriptor(ref);
        if (authRuntime.mode === "shared") {
            throw new Error(`Auth configuration for ${ref} is managed by ${authRuntime.authority_project_ref}`);
        }

        await this.ensureGotrueBinary();
        await this.installSystemdTemplate("checked");

        const pgrstPort = await this.getTenantPort(ref, "pgrst");
        const gotruePort = await this.getTenantPort(ref, "gotrue");
        await this.generateTenantConfig(ref, pgrstPort, gotruePort, "checked");

        const unit = this.gotrueController.unit(ref);
        const active = await this.gotrueController.isActive(ref);
        if (await this.gotrueController.isFailed(ref)) {
            await runSystemctlOrThrow("reset-failed", unit);
        }
        if (active) {
            await runSystemctlOrThrow("restart", unit);
        } else {
            await this.ensureAuthSchema(ref);
            await runSystemctlOrThrow("enable", unit);
            await runSystemctlOrThrow("start", unit);
        }

        const status = await this.gotrueController.waitForHealthy(ref, gotruePort, 20, 500);
        if (status.health !== "healthy") {
            throw new Error(
                status.last_error || `GoTrue runtime did not become healthy after applying auth config for ${ref}`,
            );
        }

        return { authRuntime, status };
    }

    private async restartActivePostgrestOrThrow(ref: string): Promise<void> {
        const status = await this.activatePostgrestGeneration(ref, "refresh-if-running");
        if (!status) return;
        await this.recordPostgrestObservation(ref, status);
    }

    private async reconcilePostgrestPool(
        ref: string,
        projectStatus: string,
        desired: RuntimeDesiredState,
    ): Promise<PostgrestPoolReconcileResult> {
        return this.withTenantConfigLock(ref, async () => {
            const runtimeUser = await this.ensureTenantRuntimeUser(ref);
            const context: PostgrestPoolContext = {
                ref,
                runtimeUser,
                ownership: {
                    controlOwnerUid: 0,
                    runtimeGroupGid: await this.tenantRuntimeGroupId(runtimeUser),
                },
            };
            return reconcileManagedPostgrestPool({
                projectRef: ref,
                desiredPool: this.POSTGREST_DB_POOL,
                projectStatus,
                desiredState: desired,
                operations: this.postgrestPoolOperations(context),
            });
        });
    }

    private async refreshProjectPostgrestVerifier(ref: string): Promise<void> {
        const jwtPolicy = await this.getTenantCredentials(ref);
        await this.ensurePostgrestPrerequest(
            ref,
            jwtPolicy.thirdPartyJwtPolicy,
            jwtPolicy.localJwtIssuer,
        );
        await runtimeCacheService.invalidateProjectRuntimeEnv(ref);
        await this.restartActivePostgrestOrThrow(ref);
    }

    public async applyAuthConfig(
        ref: string,
        previousAuth: Record<string, unknown>,
        nextAuth: Record<string, unknown>,
    ): Promise<GotrueRuntimeStatus> {
        const applied = await this.applyGotrueAuthConfig(ref);
        if (!authConfigChangesPostgrestVerifier(previousAuth, nextAuth)) return applied.status;

        await this.refreshProjectPostgrestVerifier(ref);
        if (applied.authRuntime.mode === "owner") {
            await this.refreshSharedAuthDependents(ref);
        }
        return applied.status;
    }

    private async listSharedAuthDependentRefs(ownerRef: string): Promise<string[]> {
        try {
            const dependents = await metaSql`
              SELECT ref
              FROM projects
              WHERE ref <> ${ownerRef}
                AND deleted_at IS NULL
                AND lower(status) IN ('active', 'creating')
            `;
            return dependents
                .map((dependent: Record<string, unknown>) => String(dependent.ref || ""))
                .filter(Boolean);
        } catch (error) {
            throw new SupAuthDependentRefreshError([], { cause: error });
        }
    }

    private async refreshSharedAuthDependents(
        ownerRef: string,
    ): Promise<void> {
        const failures: string[] = [];
        for (const ref of await this.listSharedAuthDependentRefs(ownerRef)) {
            try {
                const jwtPolicy = await this.getTenantCredentials(ref);
                await this.ensurePostgrestPrerequest(
                    ref,
                    jwtPolicy.thirdPartyJwtPolicy,
                    jwtPolicy.localJwtIssuer,
                );
                await runtimeCacheService.invalidateProjectRuntimeEnv(ref);
                await this.restartActivePostgrestOrThrow(ref);
            } catch (error: unknown) {
                failures.push(ref);
                logger.error(`[TenantRuntime] Failed to refresh shared auth dependent ${ref}`, {
                    ownerRef,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        if (failures.length > 0) {
            throw new SupAuthDependentRefreshError(failures);
        }
    }

    public async checkStatus(ref: string): Promise<RuntimeStatus> {
        const pgrstActive = await this.postgrestController.isActive(ref);
        const gotrueActive = await this.gotrueController.isActive(ref);

        const port = await this.getTenantPort(ref, "pgrst");
        const localGoTruePort = await this.getTenantPort(ref, "gotrue");
        const gotruePort = await this.effectiveGoTruePort(ref, localGoTruePort);

        if (pgrstActive || gotrueActive || isSharedAuthRuntime(ref)) {
            let pgrstOk = false;
            let gotrueOk = false;

            const postgrestStatus = await this.postgrestController.observe(ref, port);
            pgrstOk = postgrestStatus.health === "healthy";

            try {
                gotrueOk = (await fetch(`http://127.0.0.1:${gotruePort}/health`)).ok;
            } catch (e: unknown) { logger.debug("[services/tenant-runtime.service] suppressed error", { error: e instanceof Error ? e.message : String(e) }); }

            let health: RuntimeStatus["health"] = "unhealthy";
            if (pgrstOk && gotrueOk) health = "healthy";
            else if (pgrstOk || gotrueOk) health = "degraded";

            return { status: "running", port, gotruePort, health };
        }

        return { status: "stopped", port, gotruePort, health: "unknown" };
    }

    public async reconcileInactiveRuntimes(): Promise<{ checked: number; stopped: number; started: number; updated: number; errors: number }> {
        const projects = await metaSql`
          SELECT ref, status, postgrest_desired
          FROM projects
          WHERE deleted_at IS NULL
        `;
        const projectByRef = new Map<string, Record<string, unknown>>(
            projects.map((project: Record<string, unknown>) => [
                String(project.ref),
                project,
            ]),
        );
        const projectStatus = new Map<string, string>(
            projects.map((project: Record<string, unknown>) => [
                String(project.ref),
                String(project.status || ""),
            ]),
        );

        const units = await $`systemctl list-units 'supacloud-pgrst@*' 'supacloud-gotrue@*' --plain --no-pager`
            .nothrow()
            .quiet();
        const unitOutput = units.text();
        const serviceRegex = /supacloud-(?:gotrue|pgrst)@([^.]+)\.service/g;
        const refs = new Set<string>();
        let match: RegExpExecArray | null;

        while ((match = serviceRegex.exec(unitOutput)) !== null) {
            refs.add(match[1]);
        }
        for (const project of projects as Record<string, unknown>[]) {
            refs.add(String(project.ref));
        }

        let stopped = 0;
        let started = 0;
        let updated = 0;
        let errors = 0;
        this.postgrestPoolMigrationGate.beginSweep(this.POSTGREST_DB_POOL);
        for (const ref of refs) {
            const status = projectStatus.get(ref);
            const project = projectByRef.get(ref);

            try {
                if (!project) {
                    await this.stopRuntime(ref);
                    stopped++;
                    continue;
                }

                if (status !== "active" && status !== "creating") {
                    await this.pauseProjectRuntime(ref);
                    // Also pause GoTrue for inactive projects
                    await this.pauseGoTrueRuntime(ref);
                    stopped++;
                    continue;
                }

                const desired = this.getPostgrestDesiredState(project);
                let actual = await this.statusPostgrest(ref);
                let postgrestPoolError: string | null = null;

                // --- PostgREST reconcile ---
                if (desired === "stopped" && actual.actual !== "stopped") {
                    await this.pausePostgrest(ref);
                    stopped++;
                    continue;
                }

                if (desired === "running" && status === "active" && actual.health !== "healthy") {
                    actual = await this.resumePostgrest(ref);
                    started++;
                }

                if (
                    desired === "running"
                    && status === "active"
                    && actual.health === "healthy"
                    && this.postgrestPoolMigrationGate.canAttempt()
                ) {
                    let poolReconcile: PostgrestPoolReconcileResult;
                    try {
                        poolReconcile = await this.reconcilePostgrestPool(ref, status, desired);
                    } catch (error: unknown) {
                        this.postgrestPoolMigrationGate.recordFailure(this.POSTGREST_DB_POOL);
                        throw error;
                    }
                    if (poolReconcile.state === "updated" || poolReconcile.state === "rolled_back") {
                        actual = await this.statusPostgrest(ref);
                    }
                    if (poolReconcile.state === "rolled_back") {
                        this.postgrestPoolMigrationGate.recordFailure(this.POSTGREST_DB_POOL);
                        postgrestPoolError = poolReconcile.error;
                        logger.error(`[TenantRuntime] PostgREST pool update rolled back for ${ref}`, {
                            error: poolReconcile.error,
                        });
                    }
                }

                // --- GoTrue reconcile ---
                const sharedAuthRuntime = isSharedAuthRuntime(ref);
                const gotrueActive = await this.gotrueController.isActive(ref);
                const gotruePort = await this.getTenantPort(ref, "gotrue");
                const gotrueObserved = await this.gotrueController.observe(ref, gotruePort);

                if (desired === "running" && status === "active") {
                    if (sharedAuthRuntime) {
                        if (gotrueActive) await this.gotrueController.stopAndDisable(ref);
                        await this.setPostgrestDesiredState(ref, desired);
                        await this.recordPostgrestObservation(ref, {
                            actual: actual.actual,
                            health: actual.health,
                            port: actual.port,
                            last_error: postgrestPoolError
                                || (actual.health === "healthy" ? null : actual.last_error),
                        }, { reconciled: true });
                        updated++;
                        continue;
                    }
                    // Active project: ensure GoTrue is running and healthy
                    if (!gotrueActive || gotrueObserved.health !== "healthy") {
                        // Ensure config exists before starting
                        const gotrueEnvPath = path.join(this.TENANT_CONFIG_DIR, `${ref}_gotrue.env`);
                        if (!(await Bun.file(gotrueEnvPath).exists())) {
                            const pgrstPort = await this.getTenantPort(ref, "pgrst");
                            await this.generateTenantConfig(ref, pgrstPort, gotruePort);
                        }
                        // Ensure systemd template is installed
                        await this.installSystemdTemplate();
                        await this.gotrueController.startOrRepair(ref, gotruePort, "repair");
                        logger.info(`[TenantRuntime] GoTrue reconciled and started for ${ref}`);
                        started++;
                    }
                } else if (desired === "stopped") {
                    // Stopped project: ensure GoTrue is stopped
                    if (gotrueActive) {
                        await this.pauseGoTrueRuntime(ref);
                        stopped++;
                    }
                }

                await this.setPostgrestDesiredState(ref, desired);
                await this.recordPostgrestObservation(ref, {
                    actual: actual.actual,
                    health: actual.health,
                    port: actual.port,
                    last_error: postgrestPoolError
                        || (actual.health === "healthy" ? null : actual.last_error),
                }, { reconciled: true });
                updated++;
            } catch (error: unknown) {
                errors++;
                if (status) {
                    await this.recordPostgrestFailure(ref, error, { reconciled: true }).catch(() => {});
                }
                const message = error instanceof Error ? error.message : String(error);
                logger.warn(`[TenantRuntime] Failed to reconcile runtime ${ref}`, {
                    status: status || "missing",
                    error: message,
                });
            }
        }

        return { checked: refs.size, stopped, started, updated, errors };
    }

    private async pauseGoTrueRuntime(ref: string): Promise<void> {
        await this.gotrueController.stopAndDisable(ref);
        logger.info(`[TenantRuntime] GoTrue paused for ${ref}`);
    }

    public async updateOAuthConfig(ref: string, provider: OAuthProvider, providerConfig: OAuthProviderConfig): Promise<void> {
        return tenantOAuthService.updateOAuthConfig(ref, provider, providerConfig);
    }

    public async removeOAuthConfig(ref: string, provider: OAuthProvider): Promise<void> {
        return tenantOAuthService.removeOAuthConfig(ref, provider);
    }

    public async updateGoTrueCustomOAuth(ref: string, config: {
        name: string;
        client_id: string;
        client_secret: string;
        redirect_uri: string;
        authorize_url: string;
        token_url: string;
        user_url: string;
        auth_scheme?: string;
    }): Promise<void> {
        return tenantOAuthService.updateGoTrueCustomOAuth(ref, config);
    }
}

export const tenantRuntimeService = new TenantRuntimeService();

async function unitHasLegacyPostgrestMemoryLimit(unitPath: string): Promise<boolean> {
    const content = await Bun.file(unitPath).text();
    return content.includes("-M30m") || content.includes("MemoryMax=45M");
}
