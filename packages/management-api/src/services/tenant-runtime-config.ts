import { AUTH_EMAIL_TEMPLATE_DEFINITIONS } from "../utils/auth-email-templates";

export { renderGoTrueSessionPolicyEnv } from "./auth-session-policy";

const CONFIG_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/;

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

export function renderSystemdEnvLine(name: string, value: string): string {
    if (!ENVIRONMENT_NAME.test(name)) {
        throw new Error(`Invalid EnvironmentFile variable name: ${name}`);
    }
    assertSafeConfigValue(`${name} EnvironmentFile value`, value);
    return `${name}=${JSON.stringify(value)}`;
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

function readStringListSetting(value: unknown, defaultValue: string[]): string[] {
    if (Array.isArray(value)) {
        const entries = value
            .map((entry) => {
                if (typeof entry !== "string") return "";
                assertSafeConfigValue("string list entry", entry);
                return entry.trim();
            })
            .filter(Boolean);
        return entries.length > 0 ? entries : defaultValue;
    }
    if (typeof value === "string") {
        assertSafeConfigValue("string list", value);
        if (!value.trim()) return defaultValue;
        const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
        return entries.length > 0 ? entries : defaultValue;
    }
    return defaultValue;
}

export function renderGoTrueAuthEnv(authConfig: Record<string, unknown>): string {
    const disableSignup = readBooleanSetting(authConfig, "disable_signup", false)
        || readBooleanSetting(authConfig, "enable_signup", true) === false;
    const externalAnonymousUsersEnabled = readBooleanSetting(authConfig, "external_anonymous_users_enabled", true);
    const externalEmailEnabled = readBooleanSetting(authConfig, "external_email_enabled", true);
    const externalPhoneEnabled = readBooleanSetting(authConfig, "external_phone_enabled", true);

    const emailTemplateLines: string[] = [];
    for (const definition of AUTH_EMAIL_TEMPLATE_DEFINITIONS) {
        const upperSubjectKey = definition.subjectKey.toUpperCase();
        const upperContentKey = definition.contentKey.toUpperCase();
        const subject = authConfig[definition.subjectKey] ?? authConfig[upperSubjectKey];
        const content = authConfig[definition.contentKey] ?? authConfig[upperContentKey];
        if (typeof subject === "string") {
            emailTemplateLines.push(renderSystemdEnvLine(definition.envSubject, subject));
        }
        if (typeof content === "string") {
            emailTemplateLines.push(renderSystemdEnvLine(definition.envContent, content));
        }
    }

    return [
`
GOTRUE_DISABLE_SIGNUP=${disableSignup ? "true" : "false"}
GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=${externalAnonymousUsersEnabled ? "true" : "false"}
GOTRUE_EXTERNAL_EMAIL_ENABLED=${externalEmailEnabled ? "true" : "false"}
GOTRUE_EXTERNAL_PHONE_ENABLED=${externalPhoneEnabled ? "true" : "false"}
`.trim(),
        emailTemplateLines.join("\n"),
    ].filter(Boolean).join("\n");
}

export type GoTrueWebAuthnDefaults = {
    rpId: string;
    rpDisplayName: string;
    rpOrigins: string[];
};

export function renderGoTruePasskeyEnv(
    authConfig: Record<string, unknown>,
    defaults: GoTrueWebAuthnDefaults,
): string {
    const passkey = readRecordSetting(authConfig.passkey);
    const webAuthn = readRecordSetting(authConfig.webauthn);
    const mfa = readRecordSetting(authConfig.mfa ?? authConfig.MFA);
    const mfaWebAuthn = readRecordSetting(mfa.webauthn ?? mfa.WebAuthn);
    const passkeyEnabled = readBooleanSetting(passkey, "enabled", readBooleanSetting(authConfig, "passkey_enabled", false));
    const mfaEnrollEnabled = readBooleanSetting(mfaWebAuthn, "enroll_enabled", readBooleanSetting(authConfig, "mfa_webauthn_enroll_enabled", false));
    const mfaVerifyEnabled = readBooleanSetting(mfaWebAuthn, "verify_enabled", readBooleanSetting(authConfig, "mfa_webauthn_verify_enabled", false));

    if (!passkeyEnabled && !mfaEnrollEnabled && !mfaVerifyEnabled) return "";

    const rpId = readStringSetting(webAuthn, "rp_id", defaults.rpId);
    const rpDisplayName = readStringSetting(webAuthn, "rp_display_name", defaults.rpDisplayName);
    const rpOrigins = readStringListSetting(webAuthn.rp_origins, defaults.rpOrigins);
    const challengeExpiry = readStringSetting(webAuthn, "challenge_expiry_duration", "5m");
    const maxPasskeysPerUser = readPositiveIntegerSetting(passkey, "max_passkeys_per_user", 10);

    return [
        `GOTRUE_PASSKEY_ENABLED=${passkeyEnabled ? "true" : "false"}`,
        `GOTRUE_PASSKEY_MAX_PASSKEYS_PER_USER=${maxPasskeysPerUser}`,
        `GOTRUE_MFA_WEBAUTHN_ENROLL_ENABLED=${mfaEnrollEnabled ? "true" : "false"}`,
        `GOTRUE_MFA_WEBAUTHN_VERIFY_ENABLED=${mfaVerifyEnabled ? "true" : "false"}`,
        renderSystemdEnvLine("GOTRUE_WEBAUTHN_RP_ID", rpId),
        renderSystemdEnvLine("GOTRUE_WEBAUTHN_RP_DISPLAY_NAME", rpDisplayName),
        renderSystemdEnvLine("GOTRUE_WEBAUTHN_RP_ORIGINS", rpOrigins.join(",")),
        renderSystemdEnvLine("GOTRUE_WEBAUTHN_CHALLENGE_EXPIRY_DURATION", challengeExpiry),
    ].join("\n");
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
