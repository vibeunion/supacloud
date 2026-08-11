import { describe, expect, test } from "bun:test";
import { parseToolArguments } from "../schema";
import type { ToolSchema } from "../schema";
import { registerStorageTools } from "./storage-tools";

type ToolResponse = {
    content: Array<{ text: string }>;
    isError?: boolean;
};

function storageBucket(overrides: Record<string, unknown> = {}) {
    return {
        id: "reports",
        name: "reports",
        public: false,
        file_size_limit: null,
        allowed_mime_types: null,
        ...overrides,
    };
}

function captureStorageTool(http: Record<string, unknown>) {
    let schema: ToolSchema | undefined;
    let callback: ((args: Record<string, unknown>) => Promise<ToolResponse>) | undefined;
    registerStorageTools({
        tool(name, _description, toolSchema, toolCallback) {
            if (name !== "storage") return;
            schema = toolSchema;
            callback = toolCallback;
        },
    }, http as never);
    if (!schema || !callback) throw new Error("storage tool was not registered");
    return { schema, callback };
}

describe("Storage bucket CLI schema", () => {
    test("decodes comma-separated and JSON MIME type arrays", () => {
        const { schema } = captureStorageTool({});

        expect(parseToolArguments(schema, {
            action: "create_bucket",
            ref: "project-ref",
            bucket: "artifacts",
            allowed_mime_types: "application/pdf, image/png",
        }).allowed_mime_types).toEqual(["application/pdf", "image/png"]);
        expect(parseToolArguments(schema, {
            action: "update_bucket",
            ref: "project-ref",
            bucket: "artifacts",
            allowed_mime_types: '["text/csv"]',
        }).allowed_mime_types).toEqual(["text/csv"]);
    });

    test("rejects malformed JSON MIME type arrays", () => {
        const { schema } = captureStorageTool({});

        expect(() => parseToolArguments(schema, {
            action: "create_bucket",
            ref: "project-ref",
            bucket: "artifacts",
            allowed_mime_types: '["text/csv"',
        })).toThrow("Invalid allowed_mime_types JSON array");
    });

    test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
        "rejects invalid file_size_limit %s",
        (fileSizeLimit) => {
            const { schema } = captureStorageTool({});

            expect(() => parseToolArguments(schema, {
                action: "update_bucket",
                ref: "project-ref",
                bucket: "artifacts",
                file_size_limit: fileSizeLimit,
            })).toThrow("file_size_limit");
        },
    );
});

describe("Storage bucket lifecycle", () => {
    test("lists complete bucket JSON through the project route", async () => {
        const calls: string[] = [];
        const buckets = [{
            id: "artifacts",
            name: "artifacts",
            public: false,
            file_size_limit: 1048576,
            allowed_mime_types: ["application/pdf"],
        }];
        const { callback } = captureStorageTool({
            get: async (path: string) => {
                calls.push(path);
                return { ok: true, status: 200, data: buckets };
            },
        });

        const response = await callback({ action: "list_buckets", ref: "project-ref" });

        expect(calls).toEqual(["/v1/projects/project-ref/storage/buckets"]);
        expect(JSON.parse(response.content[0].text)).toEqual(buckets);
        expect(response.isError).not.toBe(true);
    });

    test("projects bucket metadata without reflecting unknown response fields", async () => {
        const secretMarker = "remote-storage-secret";
        const { callback } = captureStorageTool({
            get: async () => ({
                ok: true,
                status: 200,
                data: [storageBucket({ token: secretMarker, credentials: secretMarker })],
            }),
        });

        const response = await callback({ action: "list_buckets", ref: "project-ref" });

        expect(JSON.parse(response.content[0].text)).toEqual([storageBucket()]);
        expect(response.content[0].text).not.toContain(secretMarker);
    });

    test("gets a bucket through canonical project and bucket path segments", async () => {
        const calls: string[] = [];
        const bucket = storageBucket({ id: "raw-data.v1", name: "raw-data.v1" });
        const { callback } = captureStorageTool({
            get: async (path: string) => {
                calls.push(path);
                return { ok: true, status: 200, data: bucket };
            },
        });

        const response = await callback({ action: "get_bucket", ref: "project_ref", bucket: "raw-data.v1" });

        expect(calls).toEqual(["/v1/projects/project_ref/storage/buckets/raw-data.v1"]);
        expect(JSON.parse(response.content[0].text)).toEqual(bucket);
    });

    test.each([
        ["project ref", { action: "list_buckets", ref: "../project" }],
        ["slash bucket", { action: "get_bucket", ref: "project-ref", bucket: "raw/data" }],
        ["dot bucket", { action: "delete_bucket", ref: "project-ref", bucket: ".." }],
    ])("rejects invalid %s path input before HTTP dispatch", async (_label, args) => {
        let requestCount = 0;
        const request = async () => {
            requestCount += 1;
            return { ok: true, status: 200, data: [] };
        };
        const { callback } = captureStorageTool({ get: request, delete: request });

        await expect(callback(args)).rejects.toThrow("invalid for Storage buckets");
        expect(requestCount).toBe(0);
    });

    test("creates a bucket with every supported option", async () => {
        const calls: Array<{ method: "GET" | "POST"; path: string; body?: unknown }> = [];
        const receipt = { id: "reports", name: "reports", public: false };
        const readback = storageBucket({
            file_size_limit: 5242880,
            allowed_mime_types: ["application/pdf", "image/png"],
        });
        const { callback } = captureStorageTool({
            post: async (path: string, body: unknown) => {
                calls.push({ method: "POST", path, body });
                return { ok: true, status: 201, data: receipt };
            },
            get: async (path: string) => {
                calls.push({ method: "GET", path });
                return { ok: true, status: 200, data: readback };
            },
        });

        const response = await callback({
            action: "create_bucket",
            ref: "project-ref",
            bucket: "reports",
            public: false,
            file_size_limit: 5242880,
            allowed_mime_types: ["application/pdf", "image/png"],
        });

        expect(calls).toEqual([
            {
                method: "POST",
                path: "/v1/projects/project-ref/storage/buckets",
                body: {
                    name: "reports",
                    public: false,
                    file_size_limit: 5242880,
                    allowed_mime_types: ["application/pdf", "image/png"],
                },
            },
            { method: "GET", path: "/v1/projects/project-ref/storage/buckets/reports" },
        ]);
        expect(JSON.parse(response.content[0].text)).toEqual(readback);
    });

    test("updates only explicitly provided fields", async () => {
        const calls: Array<{ path: string; body: unknown }> = [];
        const bucket = storageBucket({ public: true, file_size_limit: 1048576, allowed_mime_types: [] });
        const { callback } = captureStorageTool({
            put: async (path: string, body: unknown) => {
                calls.push({ path, body });
                return { ok: true, status: 200, data: bucket };
            },
        });

        const response = await callback({
            action: "update_bucket",
            ref: "project-ref",
            bucket: "reports",
            public: true,
            file_size_limit: 1048576,
            allowed_mime_types: [],
        });

        expect(calls).toEqual([{
            path: "/v1/projects/project-ref/storage/buckets/reports",
            body: { public: true, file_size_limit: 1048576, allowed_mime_types: [] },
        }]);
        expect(JSON.parse(response.content[0].text)).toEqual(bucket);
    });

    test("accepts the platform's null normalization when clearing MIME restrictions", async () => {
        const { callback } = captureStorageTool({
            put: async () => ({
                ok: true,
                status: 200,
                data: storageBucket({ allowed_mime_types: null }),
            }),
        });

        const response = await callback({
            action: "update_bucket",
            ref: "project-ref",
            bucket: "reports",
            allowed_mime_types: [],
        });

        expect(response.isError).not.toBe(true);
        expect(JSON.parse(response.content[0].text).allowed_mime_types).toBeNull();
    });

    test("rejects an empty update before HTTP dispatch", async () => {
        let requestCount = 0;
        const { callback } = captureStorageTool({
            put: async () => {
                requestCount += 1;
                return { ok: true, status: 200, data: {} };
            },
        });

        await expect(callback({
            action: "update_bucket",
            ref: "project-ref",
            bucket: "reports",
        })).rejects.toThrow("requires at least one field");
        expect(requestCount).toBe(0);
    });

    test("deletes a bucket and returns the complete API receipt", async () => {
        const calls: string[] = [];
        const receipt = { id: "reports", deleted: true };
        const { callback } = captureStorageTool({
            delete: async (path: string) => {
                calls.push(path);
                return { ok: true, status: 200, data: receipt };
            },
        });

        const response = await callback({ action: "delete_bucket", ref: "project-ref", bucket: "reports" });

        expect(calls).toEqual(["/v1/projects/project-ref/storage/buckets/reports"]);
        expect(JSON.parse(response.content[0].text)).toEqual(receipt);
    });

    test("returns a structured non-success result for bucket read failures", async () => {
        const { callback } = captureStorageTool({
            get: async () => ({ ok: false, status: 404, data: { message: "private-server-detail" } }),
        });

        const response = await callback({ action: "get_bucket", ref: "project-ref", bucket: "missing" });
        const payload = JSON.parse(response.content[0].text);

        expect(response.isError).toBe(true);
        expect(payload).toMatchObject({
            ok: false,
            operation: "storage.get_bucket",
            error: { code: "HTTP_ERROR", http_status: 404 },
        });
        expect(response.content[0].text).not.toContain("private-server-detail");
    });

    test("reports an unknown outcome for transport failures during mutation", async () => {
        const { callback } = captureStorageTool({
            post: async () => ({
                ok: false,
                status: 500,
                data: { error: "Network Error" },
                transportError: true,
            }),
        });

        const response = await callback({ action: "create_bucket", ref: "project-ref", bucket: "reports" });
        const payload = JSON.parse(response.content[0].text);

        expect(response.isError).toBe(true);
        expect(payload.error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: null });
    });

    test("does not treat a malformed successful mutation response as success", async () => {
        const { callback } = captureStorageTool({
            put: async () => ({ ok: true, status: 200, data: {} }),
        });

        const response = await callback({
            action: "update_bucket",
            ref: "project-ref",
            bucket: "reports",
            public: true,
        });
        const payload = JSON.parse(response.content[0].text);

        expect(response.isError).toBe(true);
        expect(payload.error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 200 });
    });

    test("does not accept an update receipt that omits the requested change", async () => {
        const { callback } = captureStorageTool({
            put: async () => ({
                ok: true,
                status: 200,
                data: storageBucket(),
            }),
        });

        const response = await callback({
            action: "update_bucket",
            ref: "project-ref",
            bucket: "reports",
            public: true,
        });

        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 200 });
    });

    test.each([
        ["duplicate id", [storageBucket(), storageBucket({ name: "reports-copy" })]],
        ["duplicate name", [storageBucket(), storageBucket({ id: "reports-copy" })]],
    ])("rejects a bucket list with %s", async (_label, buckets) => {
        const { callback } = captureStorageTool({
            get: async () => ({ ok: true, status: 200, data: buckets }),
        });

        const response = await callback({ action: "list_buckets", ref: "project-ref" });

        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).error).toEqual({ code: "INVALID_RESPONSE", http_status: null });
    });

    test.each([
        ["invalid list file_size_limit", "list_buckets", [storageBucket({ file_size_limit: 1.5 })]],
        ["invalid get allowed_mime_types", "get_bucket", storageBucket({ allowed_mime_types: "image/png" })],
    ])("rejects %s metadata shape", async (_label, action, apiPayload) => {
        const { callback } = captureStorageTool({
            get: async () => ({ ok: true, status: 200, data: apiPayload }),
        });

        const response = await callback({ action, ref: "project-ref", bucket: "reports" });

        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).error).toEqual({ code: "INVALID_RESPONSE", http_status: null });
    });

    test("requires an update receipt id to match the bucket path", async () => {
        const { callback } = captureStorageTool({
            put: async () => ({
                ok: true,
                status: 200,
                data: storageBucket({ id: "other-bucket", name: "reports", public: true }),
            }),
        });

        const response = await callback({
            action: "update_bucket",
            ref: "project-ref",
            bucket: "reports",
            public: true,
        });

        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 200 });
    });

    test("reports an unknown create outcome when canonical readback differs", async () => {
        const { callback } = captureStorageTool({
            post: async () => ({
                ok: true,
                status: 201,
                data: { id: "reports", name: "reports", public: false },
            }),
            get: async () => ({
                ok: true,
                status: 200,
                data: storageBucket({ file_size_limit: 1, allowed_mime_types: ["text/plain"] }),
            }),
        });

        const response = await callback({
            action: "create_bucket",
            ref: "project-ref",
            bucket: "reports",
            file_size_limit: 1024,
            allowed_mime_types: ["application/pdf"],
        });

        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 200 });
    });

    test("reports an unknown create outcome when canonical readback fails", async () => {
        const { callback } = captureStorageTool({
            post: async () => ({
                ok: true,
                status: 201,
                data: { id: "reports", name: "reports", public: false },
            }),
            get: async () => ({ ok: false, status: 404, data: { message: "not found" } }),
        });

        const response = await callback({ action: "create_bucket", ref: "project-ref", bucket: "reports" });

        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 404 });
    });
});
