interface RealtimeTenantPayloadInput {
    projectRef: string;
    dbHost: string;
    dbPort: string;
    dbName: string;
    adminDbPassword: string;
    jwtSecret: string;
    jwtJwks?: unknown;
    slotName: string;
}

type JsonWebKey = Record<string, unknown>;

const PRIVATE_JWK_FIELDS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k", "aws:kms:arn"] as const;

function parseJwks(value: unknown): { keys?: unknown } | null {
    if (typeof value === "string") {
        if (!value.trim()) return null;
        try {
            return parseJwks(JSON.parse(value));
        } catch {
            return null;
        }
    }
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as { keys?: unknown }
        : null;
}

function isSupportedPublicVerificationKey(key: JsonWebKey): boolean {
    if (typeof key.kid !== "string" || !key.kid.trim()) return false;
    if (PRIVATE_JWK_FIELDS.some((field) => field in key)) return false;
    return (key.kty === "EC" && key.alg === "ES256")
        || (key.kty === "RSA" && key.alg === "RS256")
        || (key.kty === "OKP" && key.alg === "EdDSA");
}

export function normalizeRealtimeJwtJwks(value: unknown): { keys: JsonWebKey[] } | undefined {
    const parsed = parseJwks(value);
    if (!Array.isArray(parsed?.keys)) return undefined;
    const keys = parsed.keys
        .filter((key): key is JsonWebKey => Boolean(key && typeof key === "object" && !Array.isArray(key)))
        .filter(isSupportedPublicVerificationKey)
        .map((key) => ({ ...key, key_ops: ["verify"] }));
    return keys.length > 0 ? { keys } : undefined;
}

const POSTGRES_CDC_DEFAULTS = {
    ssl_enforced: false,
    region: "us-east-1",
    poll_interval_ms: 100,
    poll_max_changes: 100,
    poll_max_record_bytes: 1_048_576,
    publication: "supabase_realtime",
    db_pool: 1,
    // Realtime 仍读取这个历史拼写；同时发送 canonical 字段保证升级兼容。
    subcriber_pool_size: 1,
    subs_pool_size: 1,
} as const;

function postgresCdcSettings(input: RealtimeTenantPayloadInput) {
    return {
        ...POSTGRES_CDC_DEFAULTS,
        db_host: input.dbHost,
        db_port: input.dbPort,
        db_name: input.dbName,
        db_user: "supabase_admin",
        db_password: input.adminDbPassword,
        slot_name: input.slotName,
    };
}

export function buildRealtimeTenantPayload(input: RealtimeTenantPayloadInput) {
    const jwtJwks = normalizeRealtimeJwtJwks(input.jwtJwks);
    return {
        tenant: {
            external_id: input.projectRef,
            name: `Project ${input.projectRef}`,
            jwt_secret: input.jwtSecret,
            jwt_jwks: jwtJwks ?? null,
            extensions: [{
                type: "postgres_cdc_rls",
                settings: postgresCdcSettings(input),
            }],
        },
    };
}
