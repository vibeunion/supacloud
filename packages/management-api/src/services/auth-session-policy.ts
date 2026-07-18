export const AUTH_SESSION_POLICY_DEFAULTS = Object.freeze({
    jwt_expiry: 3600,
    refresh_token_rotation_enabled: true,
    security_refresh_token_reuse_interval: 10,
    security_update_password_require_reauthentication: true,
    password_min_length: 8,
    sessions_inactivity_timeout: null as number | null,
    sessions_single_per_user: false,
    sessions_timebox: null as number | null,
});

export type AuthSessionPolicy = {
    jwt_expiry: number;
    refresh_token_rotation_enabled: boolean;
    security_refresh_token_reuse_interval: number;
    security_update_password_require_reauthentication: boolean;
    password_min_length: number;
    sessions_inactivity_timeout: number | null;
    sessions_single_per_user: boolean;
    sessions_timebox: number | null;
};

export type AuthSessionPolicyKey = keyof AuthSessionPolicy;

type AuthSessionPolicyPatchValue = number | boolean | null;

export type AuthSessionPolicyPatch = {
    values: Partial<Record<AuthSessionPolicyKey, AuthSessionPolicyPatchValue>>;
    consumedKeys: ReadonlySet<string>;
};

export class AuthSessionPolicyValidationError extends Error {
    readonly code = "INVALID_AUTH_SESSION_POLICY";

    constructor(
        readonly field: AuthSessionPolicyKey,
        message: string,
    ) {
        super(`${field}: ${message}`);
        this.name = "AuthSessionPolicyValidationError";
    }
}

const AUTH_SESSION_POLICY_ALIASES: Record<AuthSessionPolicyKey, readonly string[]> = {
    jwt_expiry: ["jwt_exp"],
    refresh_token_rotation_enabled: ["security_refresh_token_rotation_enabled"],
    security_refresh_token_reuse_interval: ["security_refresh_token_rotation_reuse_interval"],
    security_update_password_require_reauthentication: [],
    password_min_length: [],
    sessions_inactivity_timeout: [],
    sessions_single_per_user: [],
    sessions_timebox: [],
};

const AUTH_SESSION_POLICY_KEYS = Object.keys(AUTH_SESSION_POLICY_DEFAULTS) as AuthSessionPolicyKey[];
const CONFIG_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MAX_SESSION_DURATION_SECONDS = 9_223_372_036;
const DURATION_TOKEN = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h)/gy;
const DURATION_UNIT_SECONDS: Record<string, number> = {
    ns: 1e-9,
    us: 1e-6,
    "µs": 1e-6,
    "μs": 1e-6,
    ms: 1e-3,
    s: 1,
    m: 60,
    h: 3600,
};

function invalidPolicyValue(
    field: AuthSessionPolicyKey,
    message: string,
): never {
    throw new AuthSessionPolicyValidationError(field, message);
}

function parseBooleanPolicyValue(
    field: AuthSessionPolicyKey,
    value: unknown,
): boolean | null {
    if (value === null) return null;
    if (typeof value !== "boolean") {
        return invalidPolicyValue(field, "must be a boolean or null");
    }
    return value;
}

function parseIntegerPolicyValue(
    field: AuthSessionPolicyKey,
    value: unknown,
    bounds: { min: number; max: number; zeroResets?: boolean },
): number | null {
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isInteger(value)) {
        return invalidPolicyValue(field, "must be an integer or null");
    }
    if (value < bounds.min || value > bounds.max) {
        return invalidPolicyValue(
            field,
            `must be between ${bounds.min} and ${bounds.max}`,
        );
    }
    if (bounds.zeroResets && value === 0) return null;
    return value;
}

function parseGoDurationSeconds(
    field: AuthSessionPolicyKey,
    value: string,
): number {
    if (CONFIG_CONTROL_CHARACTERS.test(value)) {
        return invalidPolicyValue(field, "contains a forbidden control character");
    }
    const input = value.trim();
    if (!input) return invalidPolicyValue(field, "duration must not be empty");

    let seconds = 0;
    let offset = 0;
    DURATION_TOKEN.lastIndex = 0;
    for (let match = DURATION_TOKEN.exec(input); match; match = DURATION_TOKEN.exec(input)) {
        if (match.index !== offset) {
            return invalidPolicyValue(field, "must be seconds or a Go duration such as 30m or 24h");
        }
        seconds += Number(match[1]) * DURATION_UNIT_SECONDS[match[2]];
        offset = DURATION_TOKEN.lastIndex;
    }
    DURATION_TOKEN.lastIndex = 0;

    if (offset !== input.length || !Number.isFinite(seconds)) {
        return invalidPolicyValue(field, "must be seconds or a Go duration such as 30m or 24h");
    }
    return seconds;
}

function parseDurationPolicyValue(
    field: AuthSessionPolicyKey,
    value: unknown,
): number | null {
    if (value === null) return null;
    const seconds = typeof value === "number"
        ? value
        : typeof value === "string"
            ? parseGoDurationSeconds(field, value)
            : invalidPolicyValue(field, "must be a non-negative number, duration string, or null");

    if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_SESSION_DURATION_SECONDS) {
        return invalidPolicyValue(
            field,
            `must be between 0 and ${MAX_SESSION_DURATION_SECONDS} seconds`,
        );
    }
    if (seconds === 0) return null;

    const normalized = Number(seconds.toFixed(9));
    if (normalized <= 0) {
        return invalidPolicyValue(field, "duration precision cannot be smaller than one nanosecond");
    }
    return normalized;
}

function parseAuthSessionPolicyValue(
    field: AuthSessionPolicyKey,
    value: unknown,
): AuthSessionPolicyPatchValue {
    switch (field) {
        case "jwt_expiry":
            // Supabase Management API accepts 0 as "use the runtime default".
            return parseIntegerPolicyValue(field, value, { min: 0, max: 604_800, zeroResets: true });
        case "security_refresh_token_reuse_interval":
            return parseIntegerPolicyValue(field, value, { min: 0, max: 2_147_483_647 });
        case "password_min_length":
            return parseIntegerPolicyValue(field, value, { min: 6, max: 32_767 });
        case "refresh_token_rotation_enabled":
        case "security_update_password_require_reauthentication":
        case "sessions_single_per_user":
            return parseBooleanPolicyValue(field, value);
        case "sessions_inactivity_timeout":
        case "sessions_timebox":
            return parseDurationPolicyValue(field, value);
    }
}

function policyValuesEqual(
    left: AuthSessionPolicyPatchValue,
    right: AuthSessionPolicyPatchValue,
): boolean {
    return Object.is(left, right);
}

export function normalizeAuthSessionPolicyPatch(
    input: Record<string, unknown>,
): AuthSessionPolicyPatch {
    const values: Partial<Record<AuthSessionPolicyKey, AuthSessionPolicyPatchValue>> = {};
    const consumedKeys = new Set<string>();

    for (const field of AUTH_SESSION_POLICY_KEYS) {
        const names = [field, ...AUTH_SESSION_POLICY_ALIASES[field]];
        const supplied = names.filter((name) => Object.prototype.hasOwnProperty.call(input, name));
        if (supplied.length === 0) continue;

        const parsed = supplied.map((name) => {
            consumedKeys.add(name);
            return parseAuthSessionPolicyValue(field, input[name]);
        });
        if (parsed.slice(1).some((value) => !policyValuesEqual(value, parsed[0]))) {
            invalidPolicyValue(field, `conflicting values supplied through ${supplied.join(", ")}`);
        }
        values[field] = parsed[0];
    }

    return { values, consumedKeys };
}

export function applyAuthSessionPolicyPatch(
    currentAuth: Record<string, unknown>,
    patch: AuthSessionPolicyPatch,
): Record<string, unknown> {
    const next = { ...currentAuth };

    for (const field of AUTH_SESSION_POLICY_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(patch.values, field)) continue;
        delete next[field];
        for (const alias of AUTH_SESSION_POLICY_ALIASES[field]) delete next[alias];

        const value = patch.values[field];
        if (value !== null && value !== undefined) next[field] = value;
    }

    return next;
}

export function readAuthSessionPolicy(
    authConfig: Record<string, unknown>,
): AuthSessionPolicy {
    const prioritizedInput: Record<string, unknown> = {};
    for (const field of AUTH_SESSION_POLICY_KEYS) {
        const preferredName = [field, ...AUTH_SESSION_POLICY_ALIASES[field]]
            .find((name) => Object.prototype.hasOwnProperty.call(authConfig, name));
        if (preferredName) prioritizedInput[preferredName] = authConfig[preferredName];
    }
    const patch = normalizeAuthSessionPolicyPatch(prioritizedInput);
    return {
        ...AUTH_SESSION_POLICY_DEFAULTS,
        ...Object.fromEntries(
            Object.entries(patch.values).filter(([, value]) => value !== null),
        ),
    } as AuthSessionPolicy;
}

function renderGoDurationSeconds(seconds: number): string {
    return `${seconds.toFixed(9).replace(/\.?0+$/, "")}s`;
}

/**
 * Environment names verified against supabase/auth v2.191.0 and v2.193.0.
 * In particular, the supported reuse variable omits the historical, invalid
 * "ROTATION" segment: GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL.
 */
export function renderGoTrueSessionPolicyEnv(authConfig: Record<string, unknown>): string {
    const policy = readAuthSessionPolicy(authConfig);
    return [
        `GOTRUE_JWT_EXP=${policy.jwt_expiry}`,
        `GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION=${policy.security_update_password_require_reauthentication}`,
        `GOTRUE_PASSWORD_MIN_LENGTH=${policy.password_min_length}`,
        `GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED=${policy.refresh_token_rotation_enabled}`,
        `GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL=${policy.security_refresh_token_reuse_interval}`,
        `GOTRUE_SESSIONS_SINGLE_PER_USER=${policy.sessions_single_per_user}`,
        policy.sessions_inactivity_timeout === null
            ? ""
            : `GOTRUE_SESSIONS_INACTIVITY_TIMEOUT=${renderGoDurationSeconds(policy.sessions_inactivity_timeout)}`,
        policy.sessions_timebox === null
            ? ""
            : `GOTRUE_SESSIONS_TIMEBOX=${renderGoDurationSeconds(policy.sessions_timebox)}`,
    ].filter(Boolean).join("\n");
}
