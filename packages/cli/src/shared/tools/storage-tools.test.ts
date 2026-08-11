import { describe, expect, test } from "bun:test";
import { parseToolArguments } from "../schema";
import type { ToolSchema } from "../schema";
import { registerStorageTools } from "./storage-tools";

type ToolResponse = {
    content: Array<{ text: string }>;
    isError?: boolean;
};

const RELEASE_SCHEMA = "supacloud.cli.release-control.v1";
const CURRENT_REVISION = "1786406400000000";
const NEXT_REVISION = "1786406400000001";

function successReceipt(operation: string, payload: Record<string, unknown>) {
    return {
        schema: RELEASE_SCHEMA,
        ok: true,
        operation,
        project_ref: "project-ref",
        ...payload,
    };
}

function storageBucket(overrides: Record<string, unknown> = {}) {
    return {
        id: "reports",
        name: "reports",
        public: false,
        file_size_limit: null,
        allowed_mime_types: null,
        revision: CURRENT_REVISION,
        ...overrides,
    };
}

function updatedBucketReceipt(overrides: Record<string, unknown> = {}) {
    return {
        ...storageBucket({ revision: NEXT_REVISION, ...overrides }),
        previous_revision: CURRENT_REVISION,
        new_revision: NEXT_REVISION,
    };
}

function deletedBucketReceipt() {
    return {
        id: "reports",
        deleted: true,
        require_empty: true,
        previous_revision: CURRENT_REVISION,
        new_revision: null,
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
        expect(parseToolArguments(schema, {
            action: "update_bucket",
            ref: "project-ref",
            bucket: "artifacts",
            allowed_mime_types: [],
        }).allowed_mime_types).toEqual([]);
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

    test.each([
        ["empty MIME", [""]],
        ["whitespace MIME", ["   "]],
        ["trailing empty CSV MIME", "application/pdf,"],
        ["overlong MIME", [`text/${"a".repeat(251)}`]],
        ["too many MIME types", Array.from({ length: 101 }, (_, index) => `application/x-${index}`)],
    ])("rejects %s", (_label, allowedMimeTypes) => {
        const { schema } = captureStorageTool({});

        expect(() => parseToolArguments(schema, {
            action: "update_bucket",
            ref: "project-ref",
            bucket: "artifacts",
            allowed_mime_types: allowedMimeTypes,
        })).toThrow("allowed_mime_types");
    });

    test("accepts exact upper boundaries", () => {
        const { schema } = captureStorageTool({});
        const allowedMimeTypes = Array.from({ length: 100 }, (_, index) => `application/x-${index}`);
        allowedMimeTypes[0] = `x/${"a".repeat(253)}`;

        const parsed = parseToolArguments(schema, {
            action: "create_bucket",
            ref: "r".repeat(64),
            bucket: "b".repeat(100),
            file_size_limit: Number.MAX_SAFE_INTEGER,
            allowed_mime_types: allowedMimeTypes,
        });

        expect(parsed.file_size_limit).toBe(Number.MAX_SAFE_INTEGER);
        expect(parsed.allowed_mime_types).toHaveLength(100);
        expect((parsed.allowed_mime_types as string[])[0]).toHaveLength(255);
    });

    test.each([
        ["invalid ref", { action: "list_buckets", ref: "bad.ref" }],
        ["dot-only bucket", { action: "get_bucket", ref: "project-ref", bucket: "..." }],
        ["overlong bucket", { action: "get_bucket", ref: "project-ref", bucket: "b".repeat(101) }],
    ])("rejects %s in the CLI schema", (_label, args) => {
        const { schema } = captureStorageTool({});
        expect(() => parseToolArguments(schema, args)).toThrow("Invalid arguments");
    });
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
            revision: CURRENT_REVISION,
        }];
        const { callback } = captureStorageTool({
            get: async (path: string) => {
                calls.push(path);
                return { ok: true, status: 200, data: buckets };
            },
        });

        const response = await callback({ action: "list_buckets", ref: "project-ref" });

        expect(calls).toEqual(["/v1/projects/project-ref/storage/buckets"]);
        expect(JSON.parse(response.content[0].text)).toEqual(successReceipt("storage.list_buckets", { buckets }));
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

        expect(JSON.parse(response.content[0].text)).toEqual(successReceipt("storage.list_buckets", {
            buckets: [storageBucket()],
        }));
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
        expect(JSON.parse(response.content[0].text)).toEqual({
            ...successReceipt("storage.get_bucket", { bucket }),
            project_ref: "project_ref",
        });
    });

    test.each([
        ["project ref", { action: "list_buckets", ref: "../project" }],
        ["slash bucket", { action: "get_bucket", ref: "project-ref", bucket: "raw/data" }],
        ["dot bucket", { action: "delete_bucket", ref: "project-ref", bucket: "..." }],
        ["long bucket", { action: "get_bucket", ref: "project-ref", bucket: "a".repeat(101) }],
        ["long ref", { action: "list_buckets", ref: "a".repeat(65) }],
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

    test.each([
        ["list_buckets", { action: "list_buckets", ref: "project-ref", bucket: "reports" }],
        ["get_bucket", { action: "get_bucket", ref: "project-ref", bucket: "reports", public: true }],
        ["create_bucket", { action: "create_bucket", ref: "project-ref", bucket: "reports", filename: "x" }],
        ["update_bucket", { action: "update_bucket", ref: "project-ref", bucket: "reports", base64_content: "eA==" }],
        ["delete_bucket", { action: "delete_bucket", ref: "project-ref", bucket: "reports", file_size_limit: 1 }],
    ])("rejects cross-action flags for %s before HTTP dispatch", async (action, args) => {
        let requestCount = 0;
        const request = async () => {
            requestCount += 1;
            return { ok: true, status: 200, data: {} };
        };
        const { callback } = captureStorageTool({ get: request, post: request, put: request, delete: request });

        await expect(callback(args)).rejects.toThrow(`not supported for '${action}'`);
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
        expect(JSON.parse(response.content[0].text)).toEqual(successReceipt("storage.create_bucket", {
            bucket_id: "reports",
            previous_revision: null,
            new_revision: CURRENT_REVISION,
            bucket: readback,
        }));
    });

    test("updates only explicitly provided fields", async () => {
        const calls: Array<{ method: "GET" | "PUT"; path: string; body?: unknown }> = [];
        const bucket = storageBucket({
            public: true,
            file_size_limit: 1048576,
            allowed_mime_types: [],
            revision: NEXT_REVISION,
        });
        const { callback } = captureStorageTool({
            put: async (path: string, body: unknown) => {
                calls.push({ method: "PUT", path, body });
                return {
                    ok: true,
                    status: 200,
                    data: updatedBucketReceipt({ public: true, file_size_limit: 1048576, allowed_mime_types: [] }),
                };
            },
            get: async (path: string) => {
                calls.push({ method: "GET", path });
                return { ok: true, status: 200, data: bucket };
            },
        });

        const response = await callback({
            action: "update_bucket",
            ref: "project-ref",
            bucket: "reports",
            expected_revision: CURRENT_REVISION,
            public: true,
            file_size_limit: 1048576,
            allowed_mime_types: [],
        });

        expect(calls).toEqual([
            {
                method: "PUT",
                path: "/v1/projects/project-ref/storage/buckets/reports",
                body: {
                    expected_revision: CURRENT_REVISION,
                    public: true,
                    file_size_limit: 1048576,
                    allowed_mime_types: [],
                },
            },
            { method: "GET", path: "/v1/projects/project-ref/storage/buckets/reports" },
        ]);
        expect(JSON.parse(response.content[0].text)).toEqual(successReceipt("storage.update_bucket", {
            bucket_id: "reports",
            previous_revision: CURRENT_REVISION,
            new_revision: NEXT_REVISION,
            bucket,
        }));
    });

    test("accepts the platform's null normalization when clearing MIME restrictions", async () => {
        const { callback } = captureStorageTool({
            put: async () => ({
                ok: true,
                status: 200,
                data: updatedBucketReceipt({ allowed_mime_types: null }),
            }),
            get: async () => ({
                ok: true,
                status: 200,
                data: storageBucket({ allowed_mime_types: null, revision: NEXT_REVISION }),
            }),
        });

        const response = await callback({
            action: "update_bucket",
            ref: "project-ref",
            bucket: "reports",
            expected_revision: CURRENT_REVISION,
            allowed_mime_types: [],
        });

        expect(response.isError).not.toBe(true);
        expect(JSON.parse(response.content[0].text).bucket.allowed_mime_types).toBeNull();
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

    test.each([
        ["update revision", { action: "update_bucket", ref: "project-ref", bucket: "reports", public: true }],
        ["delete revision", { action: "delete_bucket", ref: "project-ref", bucket: "reports", require_empty: true }],
        ["explicit empty check", {
            action: "delete_bucket",
            ref: "project-ref",
            bucket: "reports",
            expected_revision: CURRENT_REVISION,
        }],
    ])("requires %s before HTTP dispatch", async (_label, args) => {
        let requestCount = 0;
        const request = async () => {
            requestCount += 1;
            return { ok: true, status: 200, data: {} };
        };
        const { callback } = captureStorageTool({ put: request, delete: request });

        await expect(callback(args)).rejects.toThrow("required");
        expect(requestCount).toBe(0);
    });

    test("deletes a bucket and returns an independently reconciled safe receipt", async () => {
        const calls: Array<{ method: "DELETE" | "GET"; path: string }> = [];
        const receipt = deletedBucketReceipt();
        const { callback } = captureStorageTool({
            delete: async (path: string) => {
                calls.push({ method: "DELETE", path });
                return { ok: true, status: 200, data: receipt };
            },
            get: async (path: string) => {
                calls.push({ method: "GET", path });
                return { ok: false, status: 404, data: { message: "not found" } };
            },
        });

        const response = await callback({
            action: "delete_bucket",
            ref: "project-ref",
            bucket: "reports",
            expected_revision: CURRENT_REVISION,
            require_empty: true,
        });

        expect(calls).toEqual([
            {
                method: "DELETE",
                path: `/v1/projects/project-ref/storage/buckets/reports?expected_revision=${CURRENT_REVISION}&require_empty=true`,
            },
            { method: "GET", path: "/v1/projects/project-ref/storage/buckets/reports" },
        ]);
        expect(JSON.parse(response.content[0].text)).toEqual(successReceipt("storage.delete_bucket", {
            bucket_id: "reports",
            deleted: true,
            require_empty: true,
            previous_revision: CURRENT_REVISION,
            new_revision: null,
        }));
    });

    test("does not report deletion when the API rejects a concurrent write conflict", async () => {
        let readbackRequested = false;
        const { callback } = captureStorageTool({
            delete: async () => ({
                ok: false,
                status: 409,
                data: { message: "Bucket is not empty" },
            }),
            get: async () => {
                readbackRequested = true;
                return { ok: false, status: 404, data: { message: "not found" } };
            },
        });

        const response = await callback({
            action: "delete_bucket",
            ref: "project-ref",
            bucket: "reports",
            expected_revision: CURRENT_REVISION,
            require_empty: true,
        });

        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).error).toEqual({ code: "HTTP_ERROR", http_status: 409 });
        expect(readbackRequested).toBe(false);
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
            expected_revision: CURRENT_REVISION,
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
                data: updatedBucketReceipt(),
            }),
        });

        const response = await callback({
            action: "update_bucket",
            ref: "project-ref",
            bucket: "reports",
            expected_revision: CURRENT_REVISION,
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
        ["negative list file_size_limit", "list_buckets", [storageBucket({ file_size_limit: -1 })]],
        ["overflowing list file_size_limit", "list_buckets", [storageBucket({ file_size_limit: Number.MAX_SAFE_INTEGER + 1 })]],
        ["invalid get allowed_mime_types", "get_bucket", storageBucket({ allowed_mime_types: "image/png" })],
        ["empty get MIME", "get_bucket", storageBucket({ allowed_mime_types: [""] })],
        ["too many list MIME types", "list_buckets", [storageBucket({
            allowed_mime_types: Array.from({ length: 101 }, (_, index) => `application/x-${index}`),
        })]],
        ["dot-only bucket id", "get_bucket", storageBucket({ id: "...", name: "..." })],
    ])("rejects %s metadata shape", async (_label, action, apiPayload) => {
        const { callback } = captureStorageTool({
            get: async () => ({ ok: true, status: 200, data: apiPayload }),
        });

        const args = action === "get_bucket"
            ? { action, ref: "project-ref", bucket: "reports" }
            : { action, ref: "project-ref" };
        const response = await callback(args);

        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).error).toEqual({ code: "INVALID_RESPONSE", http_status: null });
    });

    test("requires an update receipt id to match the bucket path", async () => {
        const { callback } = captureStorageTool({
            put: async () => ({
                ok: true,
                status: 200,
                data: updatedBucketReceipt({ id: "other-bucket", name: "reports", public: true }),
            }),
        });

        const response = await callback({
            action: "update_bucket",
            ref: "project-ref",
            bucket: "reports",
            expected_revision: CURRENT_REVISION,
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

    test("reports an unknown update outcome when independent readback differs", async () => {
        const { callback } = captureStorageTool({
            put: async () => ({
                ok: true,
                status: 200,
                data: updatedBucketReceipt({ public: true }),
            }),
            get: async () => ({
                ok: true,
                status: 200,
                data: storageBucket({ public: false, revision: NEXT_REVISION }),
            }),
        });

        const response = await callback({
            action: "update_bucket",
            ref: "project-ref",
            bucket: "reports",
            expected_revision: CURRENT_REVISION,
            public: true,
        });

        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 200 });
    });

    test("reports an unknown delete outcome unless independent readback is a 404", async () => {
        const { callback } = captureStorageTool({
            delete: async () => ({
                ok: true,
                status: 200,
                data: deletedBucketReceipt(),
            }),
            get: async () => ({ ok: true, status: 200, data: storageBucket() }),
        });

        const response = await callback({
            action: "delete_bucket",
            ref: "project-ref",
            bucket: "reports",
            expected_revision: CURRENT_REVISION,
            require_empty: true,
        });

        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 200 });
    });
});
