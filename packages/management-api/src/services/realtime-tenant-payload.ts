interface RealtimeTenantPayloadInput {
    projectRef: string;
    dbHost: string;
    dbPort: string;
    dbName: string;
    adminDbPassword: string;
    jwtSecret: string;
    slotName: string;
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
        db_user_realtime: "supabase_realtime_admin",
        db_pass_realtime: input.adminDbPassword,
        slot_name: input.slotName,
    };
}

export function buildRealtimeTenantPayload(input: RealtimeTenantPayloadInput) {
    return {
        tenant: {
            external_id: input.projectRef,
            name: `Project ${input.projectRef}`,
            jwt_secret: input.jwtSecret,
            extensions: [{
                type: "postgres_cdc_rls",
                settings: postgresCdcSettings(input),
            }],
        },
    };
}
