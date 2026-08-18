import { renderGoTrueEmailTemplateEnv } from "../utils/auth-email-templates";
import { serializedProviderLinkingDomains } from "../utils/provider-linking";
import { renderSystemdEnvLine } from "../utils/systemd-env";

export { renderGoTrueSessionPolicyEnv } from "./auth-session-policy";
export { renderSystemdEnvLine } from "../utils/systemd-env";

const CONFIG_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function assertSafeConfigValue(name: string, value: string): void {
    if (CONFIG_CONTROL_CHARACTERS.test(value)) {
        throw new Error(`${name} contains a forbidden control character`);
    }
}

function encodeUriComponent(value: string): string {
    assertSafeConfigValue("PostgreSQL URI component", value);
    return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    );
}

export function quoteTomlBasicString(value: string): string {
    assertSafeConfigValue("TOML value", value);
    return JSON.stringify(value);
}

export interface PostgresConnectionConfig {
    user: string;
    password: string;
    host: string;
    port: string;
    database: string;
}

export interface PostgresUriConfig extends PostgresConnectionConfig {
    protocol: "postgres" | "postgresql";
}

export function buildPostgresUri(connection: PostgresUriConfig): string {
    assertSafeConfigValue("PostgreSQL host", connection.host);
    assertSafeConfigValue("PostgreSQL port", connection.port);
    if (!/^\d{1,5}$/.test(connection.port)) {
        throw new Error("PostgreSQL port must be numeric");
    }
    const host = connection.host.includes(":") && !connection.host.startsWith("[")
        ? `[${connection.host}]`
        : connection.host;
    return `${connection.protocol}://${encodeUriComponent(connection.user)}:${encodeUriComponent(connection.password)}`
        + `@${host}:${connection.port}/${encodeUriComponent(connection.database)}`;
}

export function buildTenantPsqlInvocation(
    connection: PostgresConnectionConfig,
    args: readonly string[],
): { cmd: string[]; env: { PGPASSWORD: string } } {
    for (const [name, value] of Object.entries(connection)) {
        assertSafeConfigValue(`psql ${name}`, value);
    }
    for (const arg of args) {
        assertSafeConfigValue("psql argument", arg);
    }
    return {
        cmd: [
            "psql",
            "-h", connection.host,
            "-p", connection.port,
            "-U", connection.user,
            "-d", connection.database,
            ...args,
        ],
        env: { PGPASSWORD: connection.password },
    };
}

export function stringifyJsonConfig(value: unknown): string | null {
    if (!value) return null;
    return typeof value === "string" ? value : JSON.stringify(value);
}

export function pickPositivePort(value: unknown): number | null {
    const port = Number(value);
    if (!Number.isFinite(port) || port <= 0) return null;
    return Math.trunc(port);
}

const DEFAULT_POSTGREST_SCHEMAS = ["public", "storage", "graphql_public"] as const;

export function renderPostgrestDbSchemas(includePgmqPublic = false): string {
    const schemas: string[] = [...DEFAULT_POSTGREST_SCHEMAS];
    if (includePgmqPublic) schemas.push("pgmq_public");
    return schemas.join(", ");
}

export function renderTenantInternalRuntimeEnv(pgrstPort: number, gotruePort: number): string {
    return [
        `SUPACLOUD_INTERNAL_POSTGREST_PORT=${pgrstPort}`,
        `SUPACLOUD_INTERNAL_GOTRUE_PORT=${gotruePort}`,
        `SUPACLOUD_INTERNAL_REST_URL=http://127.0.0.1:${pgrstPort}`,
    ].join("\n");
}

function readBooleanSetting(
    authConfig: Record<string, unknown>,
    key: string,
    defaultValue: boolean,
): boolean {
    const value = authConfig[key];
    return typeof value === "boolean" ? value : defaultValue;
}

function readRecordSetting(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function readStringSetting(
    authConfig: Record<string, unknown>,
    key: string,
    defaultValue = "",
): string {
    const value = authConfig[key];
    if (typeof value !== "string") return defaultValue;
    assertSafeConfigValue(key, value);
    return value.trim() || defaultValue;
}

function readPositiveIntegerSetting(
    authConfig: Record<string, unknown>,
    key: string,
    defaultValue: number,
): number {
    const value = Number(authConfig[key]);
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : defaultValue;
}

function readStringArraySetting(authConfig: Record<string, unknown>, key: string): string[] {
    const value = authConfig[key];
    const entries = typeof value === "string"
        ? value.split(",")
        : Array.isArray(value)
            ? value
            : [];
    return [...new Set(entries.map((entry) => {
        if (typeof entry !== "string") throw new Error(`${key} must contain only strings`);
        const normalized = entry.trim();
        assertSafeConfigValue(key, normalized);
        return normalized;
    }).filter(Boolean))];
}

const PASSKEY_ANDROID_ORIGIN_PATTERN = /^android:apk-key-hash:[A-Za-z0-9_-]+$/;
const PASSKEY_DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function normalizePasskeyRpId(value: string): string {
    const rpId = value.trim().toLowerCase();
    if (rpId === "[::1]") return rpId;
    if (rpId.length > 253 || !PASSKEY_DOMAIN_PATTERN.test(rpId)) {
        throw new Error("webauthn_rp_id must be a bare domain without a scheme, port, or path");
    }
    return rpId;
}

function isLoopbackPasskeyHost(hostname: string): boolean {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function validatePasskeyOrigin(origin: string, rpId: string): void {
    if (PASSKEY_ANDROID_ORIGIN_PATTERN.test(origin)) return;

    let parsed: URL;
    try {
        parsed = new URL(origin);
    } catch {
        throw new Error(`Invalid WebAuthn origin: ${origin}`);
    }
    if (parsed.origin !== origin || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
        throw new Error(`WebAuthn origin must contain only scheme, host, and optional port: ${origin}`);
    }
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackPasskeyHost(hostname))) {
        throw new Error(`WebAuthn origin must use HTTPS except for loopback hosts: ${origin}`);
    }
    if (hostname !== rpId && !hostname.endsWith(`.${rpId}`)) {
        throw new Error(`WebAuthn origin hostname must match or be a subdomain of the RP ID: ${origin}`);
    }
}

export function renderGoTruePasskeyEnv(authConfig: Record<string, unknown>): string {
    const passkey = readRecordSetting(authConfig.passkey);
    const enabled = readBooleanSetting(
        authConfig,
        "passkey_enabled",
        readBooleanSetting(passkey, "enabled", false),
    );
    if (!enabled) return "GOTRUE_PASSKEY_ENABLED=false";

    const webauthn = readRecordSetting(authConfig.webauthn);
    const rawRpId = readStringSetting(authConfig, "webauthn_rp_id", readStringSetting(webauthn, "rp_id"));
    const rpDisplayName = readStringSetting(
        authConfig,
        "webauthn_rp_display_name",
        readStringSetting(webauthn, "rp_display_name"),
    );
    const flatOrigins = readStringArraySetting(authConfig, "webauthn_rp_origins");
    const nestedOrigins = readStringArraySetting(webauthn, "rp_origins");
    const origins = flatOrigins.length > 0 ? flatOrigins : nestedOrigins;
    if (!rawRpId || !rpDisplayName || origins.length === 0) {
        throw new Error("Passkey requires webauthn_rp_id, webauthn_rp_display_name, and webauthn_rp_origins");
    }
    if (origins.length > 5) throw new Error("webauthn_rp_origins supports at most 5 origins");

    const rpId = normalizePasskeyRpId(rawRpId);
    origins.forEach((origin) => validatePasskeyOrigin(origin, rpId));
    const rawMaxPasskeys = authConfig.passkey_max_passkeys_per_user ?? passkey.max_passkeys_per_user ?? 10;
    const maxPasskeys = Number(rawMaxPasskeys);
    if (!Number.isSafeInteger(maxPasskeys) || maxPasskeys < 1) {
        throw new Error("passkey_max_passkeys_per_user must be a positive integer");
    }

    return [
        "GOTRUE_PASSKEY_ENABLED=true",
        `GOTRUE_PASSKEY_MAX_PASSKEYS_PER_USER=${maxPasskeys}`,
        renderSystemdEnvLine("GOTRUE_WEBAUTHN_RP_ID", rpId),
        renderSystemdEnvLine("GOTRUE_WEBAUTHN_RP_DISPLAY_NAME", rpDisplayName),
        renderSystemdEnvLine("GOTRUE_WEBAUTHN_RP_ORIGINS", origins.join(",")),
    ].join("\n");
}

export function renderGoTrueAuthEnv(authConfig: Record<string, unknown>): string {
    const disableSignup = readBooleanSetting(authConfig, "disable_signup", false)
        || readBooleanSetting(authConfig, "enable_signup", true) === false;
    const externalAnonymousUsersEnabled = readBooleanSetting(authConfig, "external_anonymous_users_enabled", true);
    const externalEmailEnabled = readBooleanSetting(authConfig, "external_email_enabled", true);
    const externalPhoneEnabled = readBooleanSetting(authConfig, "external_phone_enabled", false);

    return [
`
GOTRUE_DISABLE_SIGNUP=${disableSignup ? "true" : "false"}
GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=${externalAnonymousUsersEnabled ? "true" : "false"}
GOTRUE_EXTERNAL_EMAIL_ENABLED=${externalEmailEnabled ? "true" : "false"}
GOTRUE_EXTERNAL_PHONE_ENABLED=${externalPhoneEnabled ? "true" : "false"}
`.trim(),
        renderGoTrueEmailTemplateEnv(authConfig),
    ].filter(Boolean).join("\n");
}

export function renderGoTrueProviderLinkingEnv(authConfig: Record<string, unknown>): string {
    const domains = serializedProviderLinkingDomains(authConfig);
    return domains
        ? renderSystemdEnvLine("GOTRUE_EXPERIMENTAL_PROVIDER_LINKING_DOMAINS", domains)
        : "";
}

export function renderGoTrueSamlEnv(authConfig: Record<string, unknown>): string {
    const saml = readRecordSetting(authConfig.saml);
    const enabled = readBooleanSetting(saml, "enabled", readBooleanSetting(authConfig, "saml_enabled", false));
    if (!enabled) return "";

    const privateKey = readStringSetting(saml, "private_key", readStringSetting(authConfig, "saml_private_key"));
    const privateKeyNext = readStringSetting(saml, "private_key_next", readStringSetting(authConfig, "saml_private_key_next"));
    const externalUrl = readStringSetting(saml, "external_url", readStringSetting(authConfig, "saml_external_url"));
    const relayStateValidity = readStringSetting(saml, "relay_state_validity_period", "2m");
    const allowEncryptedAssertions = readBooleanSetting(saml, "allow_encrypted_assertions", readBooleanSetting(authConfig, "saml_allow_encrypted_assertions", false));
    const rateLimitAssertion = readPositiveIntegerSetting(saml, "rate_limit_assertion", 15);

    return [
        "GOTRUE_SAML_ENABLED=true",
        privateKey ? renderSystemdEnvLine("GOTRUE_SAML_PRIVATE_KEY", privateKey) : "",
        privateKeyNext ? renderSystemdEnvLine("GOTRUE_SAML_PRIVATE_KEY_NEXT", privateKeyNext) : "",
        externalUrl ? renderSystemdEnvLine("GOTRUE_SAML_EXTERNAL_URL", externalUrl) : "",
        `GOTRUE_SAML_ALLOW_ENCRYPTED_ASSERTIONS=${allowEncryptedAssertions ? "true" : "false"}`,
        renderSystemdEnvLine("GOTRUE_SAML_RELAY_STATE_VALIDITY_PERIOD", relayStateValidity),
        `GOTRUE_SAML_RATE_LIMIT_ASSERTION=${rateLimitAssertion}`,
    ].filter(Boolean).join("\n");
}
