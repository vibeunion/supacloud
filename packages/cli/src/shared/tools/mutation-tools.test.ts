import { expect, test } from "bun:test";
import { registerMutationTools } from "./mutation-tools";

const MUTATION_ID = "00000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-08-11T00:00:00.000Z";
const UPDATED_AT = "2026-08-11T00:00:00.001Z";

function mutationRecord(overrides: Record<string, unknown> = {}) {
    return {
        project_ref: "proj",
        mutation_id: MUTATION_ID,
        operation: "scheduled_functions.create",
        resource_key: null,
        request_fingerprint: "a".repeat(64),
        principal: { type: "project", id: "project:proj" },
        status: "succeeded",
        checkpoint: {},
        receipt: {},
        response_status: 200,
        failure_code: null,
        lease: { owner: null, expires_at: null, fencing_epoch: 1 },
        completed_at: UPDATED_AT,
        created_at: CREATED_AT,
        updated_at: UPDATED_AT,
        ...overrides,
    };
}

function captureMutationTool(http: Record<string, unknown>) {
    let callback: ((args: Record<string, unknown>) => Promise<{
        content: Array<{ text: string }>;
        isError?: boolean;
    }>) | undefined;
    registerMutationTools({
        tool(name, _description, _schema, toolCallback) {
            if (name === "mutations") callback = toolCallback;
        },
    }, http as never);
    if (!callback) throw new Error("mutations tool was not registered");
    return callback;
}

test("Mutation status reads the exact bounded path and emits the fixed public projection", async () => {
    const requests: Array<{ path: string; options: Record<string, unknown> }> = [];
    const callback = captureMutationTool({
        get: async (path: string, options: Record<string, unknown>) => {
            requests.push({ path, options });
            return {
                ok: true,
                status: 200,
                data: {
                    project_ref: "proj",
                    mutation: mutationRecord(),
                },
            };
        },
    });

    const response = await callback({ action: "status", ref: "proj", mutation_id: MUTATION_ID });
    const payload = JSON.parse(response.content[0].text);

    expect(requests).toEqual([{
        path: `/v1/projects/proj/mutations/${MUTATION_ID}`,
        options: { maxResponseBytes: 196_608 },
    }]);
    expect(payload).toMatchObject({
        ok: true,
        operation: "mutations.status",
        project_ref: "proj",
        mutation: {
            mutation_id: MUTATION_ID,
            status: "succeeded",
            checkpoint: {},
            receipt: {},
        },
    });
});

test.each([
    ["non-empty checkpoint", { checkpoint: { phase: "private-checkpoint-sentinel" } }, "private-checkpoint-sentinel"],
    ["non-empty receipt", { receipt: { summary: "private-receipt-sentinel" } }, "private-receipt-sentinel"],
    ["extra mutation field", { detail: "private-detail-sentinel" }, "private-detail-sentinel"],
    ["extra lease field", {
        lease: {
            owner: null, expires_at: null, fencing_epoch: 1, lease_token: "private-lease-sentinel",
        },
    }, "private-lease-sentinel"],
] as const)("Mutation status rejects a %s without reflecting it", async (_label, overrides, sentinel) => {
    const callback = captureMutationTool({
        get: async () => ({
            ok: true,
            status: 200,
            data: { project_ref: "proj", mutation: mutationRecord(overrides) },
        }),
    });

    const response = await callback({ action: "status", ref: "proj", mutation_id: MUTATION_ID });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).error).toEqual({
        code: "INVALID_RESPONSE", http_status: null,
    });
    expect(response.content[0].text).not.toContain(sentinel);
});

test("Mutation status rejects extra response fields without reflecting them", async () => {
    const privateSentinel = "private-response-sentinel";
    const callback = captureMutationTool({
        get: async () => ({
            ok: true,
            status: 200,
            data: {
                project_ref: "proj",
                mutation: mutationRecord(),
                detail: privateSentinel,
            },
        }),
    });

    const response = await callback({ action: "status", ref: "proj", mutation_id: MUTATION_ID });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).not.toContain(privateSentinel);
});

test("Mutation status reports HTTP failure without reflecting the server body", async () => {
    const privateSentinel = "private-server-error";
    const callback = captureMutationTool({
        get: async () => ({
            ok: false,
            status: 503,
            data: { error: privateSentinel },
        }),
    });

    const response = await callback({ action: "status", ref: "proj", mutation_id: MUTATION_ID });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).error).toEqual({
        code: "HTTP_ERROR", http_status: 503,
    });
    expect(response.content[0].text).not.toContain(privateSentinel);
});
