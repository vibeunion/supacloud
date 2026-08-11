import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerScheduledFunctionTools } from "./scheduled-function-tools";
import { parseToolArguments } from "../schema";
import type { ToolSchema } from "../schema";

const SCHEDULE_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_SCHEDULE_ID = "00000000-0000-4000-8000-000000000002";
const UPDATED_AT = "2026-08-11T00:00:00.000Z";
const NEXT_UPDATED_AT = "2026-08-11T00:00:00.001Z";

function scheduleRecord(overrides: Record<string, unknown> = {}) {
    return {
        id: SCHEDULE_ID,
        name: "Nightly",
        slug: "worker",
        cron: "0 2 * * *",
        method: "POST",
        enabled: true,
        body_empty: true,
        header_names: [],
        created_at: UPDATED_AT,
        updated_at: UPDATED_AT,
        ...overrides,
    };
}

function scheduleReceipt(request: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
    const body = request.body as Record<string, unknown> | undefined;
    const headers = request.headers as Record<string, string> | undefined;
    const echoedFields = Object.fromEntries(
        ["name", "slug", "cron", "method", "enabled"]
            .filter((field) => request[field] !== undefined)
            .map((field) => [field, request[field]]),
    );
    return scheduleRecord({
        ...echoedFields,
        body_empty: Object.keys(body ?? {}).length === 0,
        header_names: Object.keys(headers ?? {}).sort(),
        ...overrides,
    });
}

function captureScheduledFunctionsTool(
    http: Record<string, unknown>,
    environment: NodeJS.ProcessEnv = {},
    options: { readOnly?: boolean } = {},
) {
    let schema: ToolSchema | undefined;
    let callback: ((args: Record<string, unknown>) => Promise<{
        content: Array<{ text: string }>;
        isError?: boolean;
    }>) | undefined;
    registerScheduledFunctionTools({
        tool(name, _description, toolSchema, toolCallback) {
            if (name !== "scheduled_functions") return;
            schema = toolSchema;
            callback = toolCallback;
        },
    }, http as never, environment, options);
    if (!schema || !callback) throw new Error("scheduled_functions tool was not registered");
    return { schema, callback };
}

test("Scheduled Function list emits only safe machine-readable metadata", async () => {
    const bodySentinel = "private-body-sentinel";
    const headerSentinel = "private-header-sentinel";
    const { callback } = captureScheduledFunctionsTool({
        get: async () => ({
            ok: true,
            status: 200,
            data: {
                project_ref: "proj",
                schedules: [scheduleRecord({
                    body_empty: false,
                    header_names: ["x-schedule-token"],
                    body: { private: bodySentinel },
                    headers: { "X-Schedule-Token": headerSentinel },
                })],
            },
        }),
    });

    const response = await callback({ action: "list", ref: "proj" });
    const payload = JSON.parse(response.content[0].text);

    expect(payload.schedules[0]).toMatchObject({
        id: SCHEDULE_ID,
        body_empty: false,
        header_names: ["x-schedule-token"],
        updated_at: UPDATED_AT,
    });
    expect(response.content[0].text).not.toContain(bodySentinel);
    expect(response.content[0].text).not.toContain(headerSentinel);
});

test("Scheduled Function read-only mode blocks writes before body-file reads or HTTP dispatch", async () => {
    let requestCount = 0;
    const { callback } = captureScheduledFunctionsTool({
        post: async () => { requestCount += 1; },
        patch: async () => { requestCount += 1; },
        delete: async () => { requestCount += 1; },
    }, {}, { readOnly: true });

    for (const args of [
        {
            action: "create",
            ref: "proj",
            body_file: "/definitely/not/exist/schedule-body.json",
        },
        {
            action: "update",
            ref: "proj",
            schedule_id: SCHEDULE_ID,
            body_file: "/definitely/not/exist/schedule-body.json",
        },
        { action: "delete", ref: "proj", schedule_id: SCHEDULE_ID },
    ]) {
        const response = await callback(args);
        expect(response.isError).toBe(true);
        expect(response.content[0].text).toContain("read-only");
    }

    expect(requestCount).toBe(0);
});

test("Scheduled Function read-only mode continues to allow list", async () => {
    let requestCount = 0;
    const { callback } = captureScheduledFunctionsTool({
        get: async () => {
            requestCount += 1;
            return { ok: true, status: 200, data: { project_ref: "proj", schedules: [] } };
        },
    }, {}, { readOnly: true });

    const response = await callback({ action: "list", ref: "proj" });

    expect(response.isError).not.toBe(true);
    expect(requestCount).toBe(1);
});

test("Scheduled Function get preserves the exact canonical revision in read-only mode", async () => {
    const paths: string[] = [];
    const { callback } = captureScheduledFunctionsTool({
        get: async (path: string) => {
            paths.push(path);
            return {
                ok: true,
                status: 200,
                data: { project_ref: "proj", schedule: scheduleRecord() },
            };
        },
    }, {}, { readOnly: true });

    const response = await callback({ action: "get", ref: "proj", schedule_id: SCHEDULE_ID });
    const receipt = JSON.parse(response.content[0].text);

    expect(response.isError).not.toBe(true);
    expect(paths).toEqual([`/v1/projects/proj/scheduled-functions/${SCHEDULE_ID}`]);
    expect(receipt).toMatchObject({
        ok: true,
        operation: "scheduled_functions.get",
        schedule: { id: SCHEDULE_ID, updated_at: UPDATED_AT },
    });
});

test("Scheduled Function create reads body and header values outside argv", async () => {
    const directory = mkdtempSync(join(tmpdir(), "supacloud-schedule-test-"));
    const bodyPath = join(directory, "body.json");
    const bodySentinel = "private-body-sentinel";
    const headerSentinel = "private-header-sentinel";
    writeFileSync(bodyPath, JSON.stringify({ private: bodySentinel }));
    const requests: unknown[] = [];
    const { schema, callback } = captureScheduledFunctionsTool({
        post: async (_path: string, request: unknown) => {
            requests.push(request);
            const mutation = request as Record<string, unknown>;
            return {
                ok: true,
                status: 200,
                data: {
                    created: true,
                    project_ref: "proj",
                    request_id: mutation.request_id,
                    schedule: scheduleReceipt(mutation),
                },
            };
        },
    }, { SCHEDULE_TOKEN: headerSentinel });
    try {
        const parsed = parseToolArguments(schema, {
            action: "create",
            ref: "proj",
            name: "Nightly",
            slug: "worker",
            cron: "0 2 * * *",
            method: "POST",
            body_file: bodyPath,
            header_env: '{"X-Schedule-Token":"SCHEDULE_TOKEN"}',
        });
        const response = await callback(parsed);

        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
            name: "Nightly",
            slug: "worker",
            cron: "0 2 * * *",
            method: "POST",
            body: { private: bodySentinel },
            headers: { "x-schedule-token": headerSentinel },
        });
        expect((requests[0] as Record<string, unknown>).request_id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(response.content[0].text).not.toContain(bodySentinel);
        expect(response.content[0].text).not.toContain(headerSentinel);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test.each([
    ["HTTP failure", { ok: false, status: 503, data: { error: "private-server-detail" } }, "HTTP_ERROR", 503],
    ["malformed success", { ok: true, status: 200, data: { project_ref: "proj", schedules: {} } }, "INVALID_RESPONSE", null],
    ["null body", {
        ok: true,
        status: 200,
        data: { project_ref: "proj", schedules: [scheduleRecord({ body_empty: null })] },
    }, "INVALID_RESPONSE", null],
])("Scheduled Function list fails closed for %s", async (_label, result, expectedCode, expectedStatus) => {
    const { callback } = captureScheduledFunctionsTool({ get: async () => result });

    const response = await callback({ action: "list", ref: "proj" });
    const payload = JSON.parse(response.content[0].text);

    expect(response.isError).toBe(true);
    expect(payload.error).toEqual({ code: expectedCode, http_status: expectedStatus });
    expect(response.content[0].text).not.toContain("private-server-detail");
});

test.each([
    ` ${UPDATED_AT}`,
    "2026-08-11T00:00:00Z",
    "2026-08-11T08:00:00.000+08:00",
    "2026-02-30T00:00:00.000Z",
])("Scheduled Function list rejects non-canonical updated_at %j", async (updatedAt) => {
    const { callback } = captureScheduledFunctionsTool({
        get: async () => ({
            ok: true,
            status: 200,
            data: { project_ref: "proj", schedules: [scheduleRecord({ updated_at: updatedAt })] },
        }),
    });

    const response = await callback({ action: "list", ref: "proj" });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).error.code).toBe("INVALID_RESPONSE");
});

test.each([
    ["update", undefined],
    ["delete", undefined],
    ["update", ` ${UPDATED_AT}`],
    ["delete", "2026-08-11T00:00:00Z"],
    ["update", "2026-08-11T08:00:00.000+08:00"],
    ["delete", "2026-02-30T00:00:00.000Z"],
] as const)("Scheduled Function %s requires canonical expected_updated_at before HTTP", async (action, expectedUpdatedAt) => {
    let requestCount = 0;
    const { callback } = captureScheduledFunctionsTool({
        patch: async () => { requestCount += 1; },
        delete: async () => { requestCount += 1; },
    });
    const args: Record<string, unknown> = {
        action,
        ref: "proj",
        schedule_id: SCHEDULE_ID,
        ...(action === "update" ? { enabled: false } : {}),
        ...(expectedUpdatedAt === undefined ? {} : { expected_updated_at: expectedUpdatedAt }),
    };

    await expect(callback(args)).rejects.toThrow("canonical UTC timestamp");
    expect(requestCount).toBe(0);
});

test("Scheduled Function update confirms the exact schedule and requested fields", async () => {
    const requests: unknown[] = [];
    const { callback } = captureScheduledFunctionsTool({
        patch: async (_path: string, request: Record<string, unknown>) => {
            requests.push(request);
            return {
                ok: true,
                status: 200,
                data: {
                    updated: true,
                    project_ref: "proj",
                    request_id: request.request_id,
                    previous_updated_at: request.expected_updated_at,
                    schedule: scheduleReceipt(request, { id: SCHEDULE_ID, updated_at: NEXT_UPDATED_AT }),
                },
            };
        },
    });

    const response = await callback({
        action: "update",
        ref: "proj",
        schedule_id: SCHEDULE_ID,
        expected_updated_at: UPDATED_AT,
        cron: "0 3 * * *",
        enabled: false,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ expected_updated_at: UPDATED_AT, cron: "0 3 * * *", enabled: false });
    expect((requests[0] as Record<string, unknown>).request_id).toBeString();
    expect(JSON.parse(response.content[0].text)).toMatchObject({
        ok: true,
        previous_updated_at: UPDATED_AT,
        schedule: { id: SCHEDULE_ID, cron: "0 3 * * *", enabled: false },
    });
});

test("Scheduled Function update rejects a mismatched receipt without exposing response values", async () => {
    const responseSentinel = "private-mismatched-response-sentinel";
    const { callback } = captureScheduledFunctionsTool({
        patch: async (_path: string, request: Record<string, unknown>) => ({
            ok: true,
            status: 200,
            data: {
                updated: true,
                project_ref: "proj",
                request_id: request.request_id,
                previous_updated_at: request.expected_updated_at,
                schedule: scheduleRecord({
                    id: OTHER_SCHEDULE_ID,
                    cron: "0 3 * * *",
                    updated_at: NEXT_UPDATED_AT,
                    body: { private: responseSentinel },
                }),
            },
        }),
    });

    const response = await callback({
        action: "update",
        ref: "proj",
        schedule_id: SCHEDULE_ID,
        expected_updated_at: UPDATED_AT,
        cron: "0 3 * * *",
    });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).error).toEqual({
        code: "OUTCOME_UNKNOWN",
        http_status: 200,
    });
    expect(response.content[0].text).not.toContain(responseSentinel);
});

test.each([
    ["mismatched previous revision", "2026-08-10T23:59:59.999Z", NEXT_UPDATED_AT],
    ["non-advancing revision", UPDATED_AT, UPDATED_AT],
])("Scheduled Function update rejects %s receipt", async (_label, previousUpdatedAt, updatedAt) => {
    const { callback } = captureScheduledFunctionsTool({
        patch: async (_path: string, request: Record<string, unknown>) => ({
            ok: true,
            status: 200,
            data: {
                updated: true,
                project_ref: "proj",
                request_id: request.request_id,
                previous_updated_at: previousUpdatedAt,
                schedule: scheduleReceipt(request, { id: SCHEDULE_ID, updated_at: updatedAt }),
            },
        }),
    });

    const response = await callback({
        action: "update",
        ref: "proj",
        schedule_id: SCHEDULE_ID,
        expected_updated_at: UPDATED_AT,
        enabled: false,
    });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).error.code).toBe("OUTCOME_UNKNOWN");
});

test("Scheduled Function list rejects duplicate schedule IDs", async () => {
    const { callback } = captureScheduledFunctionsTool({
        get: async () => ({
            ok: true,
            status: 200,
            data: {
                project_ref: "proj",
                schedules: [scheduleRecord(), scheduleRecord({ name: "Duplicate" })],
            },
        }),
    });

    const response = await callback({ action: "list", ref: "proj" });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).error.code).toBe("INVALID_RESPONSE");
});

test.each([
    ["dot project ref", { action: "list", ref: "." }],
    ["dot-dot project ref", { action: "list", ref: ".." }],
    ["dot schedule ID", { action: "delete", ref: "proj", schedule_id: "." }],
    ["dot-dot schedule ID", { action: "delete", ref: "proj", schedule_id: ".." }],
    ["encoded dot", { action: "delete", ref: "proj", schedule_id: "%2e" }],
    ["encoded dot-dot", { action: "delete", ref: "proj", schedule_id: "%2e%2e" }],
    ["mixed encoded dot-dot", { action: "delete", ref: "proj", schedule_id: ".%2e" }],
    ["double-encoded dot-dot", { action: "delete", ref: "proj", schedule_id: "%252e%252e" }],
    ["slash", { action: "delete", ref: "proj", schedule_id: "a/b" }],
    ["query", { action: "delete", ref: "proj", schedule_id: "a?b" }],
    ["fragment", { action: "delete", ref: "proj", schedule_id: "a#b" }],
    ["overlong", { action: "delete", ref: "proj", schedule_id: "a".repeat(161) }],
])("Scheduled Function rejects %s before HTTP dispatch", async (_label, args) => {
    let requestCount = 0;
    const { callback } = captureScheduledFunctionsTool({
        get: async () => { requestCount += 1; },
        delete: async () => { requestCount += 1; },
    });

    await expect(callback(args)).rejects.toThrow("invalid");
    expect(requestCount).toBe(0);
});

test.each([
    "authorization",
    "APIKEY",
    "X-Project-Ref",
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "proxy-authorization",
    "proxy-authenticate",
    "forwarded",
    "x-forwarded-host",
])(
    "Scheduled Function rejects reserved header %s before HTTP dispatch",
    async (headerName) => {
        let requestCount = 0;
        const { callback } = captureScheduledFunctionsTool({
            post: async () => { requestCount += 1; },
        }, { SCHEDULE_TOKEN: "private-header-sentinel" });

        await expect(callback({
            action: "create",
            ref: "proj",
            name: "Unsafe",
            slug: "worker",
            cron: "* * * * *",
            method: "POST",
            header_env: { [headerName]: "SCHEDULE_TOKEN" },
        })).rejects.toThrow("SCHEDULE_HEADER_MAPPING_INVALID");
        expect(requestCount).toBe(0);
    },
);

test("Scheduled Function rejects duplicate case-insensitive headers before HTTP dispatch", async () => {
    let requestCount = 0;
    const { callback } = captureScheduledFunctionsTool({
        post: async () => { requestCount += 1; },
    }, { FIRST_TOKEN: "first", SECOND_TOKEN: "second" });

    await expect(callback({
        action: "create",
        ref: "proj",
        name: "Unsafe",
        slug: "worker",
        cron: "* * * * *",
        method: "POST",
        header_env: { "X-Schedule-Token": "FIRST_TOKEN", "x-schedule-token": "SECOND_TOKEN" },
    })).rejects.toThrow("SCHEDULE_HEADER_INVALID");
    expect(requestCount).toBe(0);
});

test("Scheduled Function rejects an invalid header value without exposing it", async () => {
    const secretSentinel = "private-invalid-header-sentinel\n";
    let requestCount = 0;
    const { callback } = captureScheduledFunctionsTool({
        post: async () => { requestCount += 1; },
    }, { SCHEDULE_TOKEN: secretSentinel });

    let errorMessage = "";
    try {
        await callback({
            action: "create",
            ref: "proj",
            name: "Unsafe",
            slug: "worker",
            cron: "* * * * *",
            method: "POST",
            header_env: { "x-schedule-token": "SCHEDULE_TOKEN" },
        });
    } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toBe("SCHEDULE_HEADER_INVALID");
    expect(errorMessage).not.toContain(secretSentinel.trim());
    expect(requestCount).toBe(0);
});

test("Scheduled Function reports an unknown outcome after a transport failure", async () => {
    const { callback } = captureScheduledFunctionsTool({
        delete: async () => ({
            ok: false,
            status: 500,
            data: { error: "private-network-detail" },
            transportError: true,
        }),
    });

    const response = await callback({
        action: "delete",
        ref: "proj",
        schedule_id: SCHEDULE_ID,
        expected_updated_at: UPDATED_AT,
    });
    const receipt = JSON.parse(response.content[0].text);

    expect(response.isError).toBe(true);
    expect(receipt.error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: null });
    expect(response.content[0].text).not.toContain("private-network-detail");
});

test.each([408, 500, 503])(
    "Scheduled Function reports an unknown mutation outcome after HTTP %s",
    async (status) => {
        const { callback } = captureScheduledFunctionsTool({
            delete: async () => ({
                ok: false,
                status,
                data: { error: "private-server-detail" },
            }),
        });

        const response = await callback({
            action: "delete",
            ref: "proj",
            schedule_id: SCHEDULE_ID,
            expected_updated_at: UPDATED_AT,
        });
        const receipt = JSON.parse(response.content[0].text);

        expect(response.isError).toBe(true);
        expect(receipt.error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: status });
        expect(response.content[0].text).not.toContain("private-server-detail");
    },
);

test("Scheduled Function rejects a mismatched request receipt", async () => {
    const { callback } = captureScheduledFunctionsTool({
        patch: async (_path: string, request: Record<string, unknown>) => ({
            ok: true,
            status: 200,
            data: {
                updated: true,
                project_ref: "proj",
                request_id: "00000000-0000-4000-8000-000000000099",
                previous_updated_at: request.expected_updated_at,
                schedule: scheduleReceipt(request, { id: SCHEDULE_ID, updated_at: NEXT_UPDATED_AT }),
            },
        }),
    });

    const response = await callback({
        action: "update",
        ref: "proj",
        schedule_id: SCHEDULE_ID,
        expected_updated_at: UPDATED_AT,
        enabled: false,
    });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).error).toEqual({
        code: "OUTCOME_UNKNOWN",
        http_status: 200,
    });
});

test.each([
    "0-999999999 * * * *",
    "*/999999999 * * * *",
    "60 * * * *",
    "59-0 * * * *",
    "*/0 * * * *",
])("Scheduled Function rejects unsafe cron %s before HTTP dispatch", async (cron) => {
    let requestCount = 0;
    const { callback } = captureScheduledFunctionsTool({
        post: async () => { requestCount += 1; },
    });

    await expect(callback({
        action: "create",
        ref: "proj",
        name: "Unsafe",
        slug: "worker",
        cron,
        method: "POST",
    })).rejects.toThrow("'cron' is invalid");
    expect(requestCount).toBe(0);
});

test("Scheduled Function delete validates the exact receipt", async () => {
    const paths: string[] = [];
    const { callback } = captureScheduledFunctionsTool({
        delete: async (path: string) => {
            paths.push(path);
            return {
                ok: true,
                status: 200,
                data: {
                    deleted: true,
                    project_ref: "proj",
                    schedule_id: SCHEDULE_ID,
                    deleted_updated_at: UPDATED_AT,
                },
            };
        },
    });

    const response = await callback({
        action: "delete",
        ref: "proj",
        schedule_id: SCHEDULE_ID,
        expected_updated_at: UPDATED_AT,
    });

    expect(paths).toEqual([
        `/v1/projects/proj/scheduled-functions/${SCHEDULE_ID}?expected_updated_at=${encodeURIComponent(UPDATED_AT)}`,
    ]);
    expect(JSON.parse(response.content[0].text)).toMatchObject({
        ok: true,
        deleted: true,
        deleted_updated_at: UPDATED_AT,
    });
});

test("Scheduled Function delete rejects a receipt bound to another revision", async () => {
    const { callback } = captureScheduledFunctionsTool({
        delete: async () => ({
            ok: true,
            status: 200,
            data: {
                deleted: true,
                project_ref: "proj",
                schedule_id: SCHEDULE_ID,
                deleted_updated_at: NEXT_UPDATED_AT,
            },
        }),
    });

    const response = await callback({
        action: "delete",
        ref: "proj",
        schedule_id: SCHEDULE_ID,
        expected_updated_at: UPDATED_AT,
    });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).error.code).toBe("OUTCOME_UNKNOWN");
});

test("Scheduled Function rejects a body file over 1 MiB before HTTP dispatch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "supacloud-schedule-large-test-"));
    const bodyPath = join(directory, "body.json");
    writeFileSync(bodyPath, JSON.stringify({ payload: "x".repeat(1_048_576) }));
    let requestCount = 0;
    const { callback } = captureScheduledFunctionsTool({
        post: async () => { requestCount += 1; },
    });
    try {
        await expect(callback({
            action: "create",
            ref: "proj",
            name: "Oversized",
            slug: "worker",
            cron: "* * * * *",
            method: "POST",
            body_file: bodyPath,
        })).rejects.toThrow("no larger than 1 MiB");
        expect(requestCount).toBe(0);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
