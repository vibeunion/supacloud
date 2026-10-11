import { describe, expect, spyOn, test } from "bun:test";
import { runCli } from "../cli";
import type { ToolSchema } from "../schema";
import type { ToolInvocation, ToolServer } from "../tool-server";
import { HttpTransport, type HttpGetOptions, type HttpPostOptions, type HttpResult } from "../transports/http";
import { registerBranchTools, type BranchHttpTransport } from "./branch-tools";

const PLAN_CHECKSUM = "a".repeat(64);
const MIGRATION_CHECKSUM = "b".repeat(64);
const PROMOTE = { action: "promote", branch_ref: "preview", plan_checksum: PLAN_CHECKSUM };
const PLAN = { action: "promotion_plan", branch_ref: "preview" };

function migrationEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        version: "202607180001", name: "add_accounts", checksum: MIGRATION_CHECKSUM,
        statement_count: 1, statements: ["create table accounts(id bigint)"], destructive: false,
        ...overrides,
    };
}

function promotionPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        mode: "migrations", parent_ref: "parent", branch_ref: "preview", safe_to_apply: true,
        plan_checksum: PLAN_CHECKSUM, pending: [migrationEntry()], applied: [], blocked: [],
        warnings: [], requires_destructive_confirmation: false, ignored_branch_data: true,
        ...overrides,
    };
}

function promotionResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        promoted: true, mode: "migrations", project_ref: "parent", branch_ref: "preview",
        applied: [migrationEntry()],
        plan: promotionPlan({ pending: [], applied: [migrationEntry()], plan_checksum: "c".repeat(64) }),
        branch_data_copied: false,
        ...overrides,
    };
}

function ok(data: unknown): HttpResult {
    return { ok: true, status: 200, data };
}

interface MockHttp {
    get?: (path: string, options?: HttpGetOptions) => Promise<HttpResult>;
    post?: (path: string, body?: unknown, options?: HttpPostOptions) => Promise<HttpResult>;
    delete?: (path: string) => Promise<HttpResult>;
}

function mockHttp(handlers: MockHttp): BranchHttpTransport {
    return {
        async get<T>(path: string, options?: HttpGetOptions) {
            if (!handlers.get) throw new Error("Unexpected GET");
            const result = await handlers.get(path, options);
            return { ...result, data: result.data as T };
        },
        async post<T>(path: string, body?: unknown, options?: HttpPostOptions) {
            if (!handlers.post) throw new Error("Unexpected POST");
            const result = await handlers.post(path, body, options);
            return { ...result, data: result.data as T };
        },
        async delete<T>(path: string) {
            if (!handlers.delete) throw new Error("Unexpected DELETE");
            const result = await handlers.delete(path);
            return { ...result, data: result.data as T };
        },
    };
}

function register(
    http: BranchHttpTransport,
    options: { projectRef?: string; readOnly?: boolean } = { projectRef: "parent" },
): ToolInvocation {
    let callback: ToolInvocation | undefined;
    const server: ToolServer = {
        tool(name, _description, _schema, toolCallback) {
            if (name === "branch") callback = toolCallback;
        },
    };
    registerBranchTools(server, http, options);
    if (!callback) throw new Error("branch tool was not registered");
    return callback;
}

function captureBranchTool(handlers: MockHttp = {}, options?: { projectRef?: string; readOnly?: boolean }): ToolInvocation {
    return register(mockHttp({
        ...handlers,
        ...(handlers.post && !handlers.get ? { get: async () => ok(promotionPlan()) } : {}),
    }), options);
}

function text(result: Awaited<ReturnType<ToolInvocation>>): string {
    return result.content[0]?.text ?? "";
}

function payload(result: Awaited<ReturnType<ToolInvocation>>): Record<string, unknown> {
    return JSON.parse(text(result)) as Record<string, unknown>;
}

describe("branch CLI promotion", () => {
    test("renders a scoped plan without exposing SQL", async () => {
        const callback = captureBranchTool({ get: async () => ok(promotionPlan()) });
        const result = await callback(PLAN);
        expect(result.isError).toBeUndefined();
        expect(text(result)).toContain("add_accounts");
        expect(text(result)).toContain("Branch data will not be automatically copied");
        expect(text(result)).not.toContain("create table");
    });

    test("returns bounded JSON plans with only sanitized summary fields", async () => {
        const callback = captureBranchTool({
            get: async (path, options) => {
                expect(path).toBe("/v1/projects/parent/branches/preview/promote/plan");
                expect(options).toEqual({ maxJsonBytes: 512 * 1024, responseTimeoutMs: 5_000 });
                return ok(promotionPlan({ warnings: ["password=secret"], password: "secret" }));
            },
        });
        const result = await callback({ ...PLAN, json: true });
        expect(payload(result)).toMatchObject({
            ok: true, operation: "branch.promotion_plan", project_ref: "parent", branch_ref: "preview",
            plan: { plan_checksum: PLAN_CHECKSUM },
        });
        expect(text(result)).not.toContain("secret");
        expect(text(result)).not.toContain("statements");
    });

    test("renders locally defined blocked-plan messages without remote error text", async () => {
        const callback = captureBranchTool({
            get: async () => ok(promotionPlan({
                safe_to_apply: false, pending: [],
                blocked: [{ code: "checksum_mismatch", version: "202607180001", name: null, message: "password=secret" }],
            })),
        });
        const result = await callback(PLAN);
        expect(text(result)).toContain("BLOCKED");
        expect(text(result)).toContain("Parent and branch migration checksums differ");
        expect(text(result)).not.toContain("secret");
    });

    test("preserves the destructive confirmation requirement", async () => {
        const callback = captureBranchTool({
            get: async () => ok(promotionPlan({
                pending: [migrationEntry({ destructive: true })],
                requires_destructive_confirmation: true,
            })),
        });
        expect(text(await callback(PLAN))).toContain("--confirm_destructive true");
    });

    test.each([
        ["missing scope", { parent_ref: undefined }],
        ["foreign parent", { parent_ref: "foreign" }],
        ["foreign branch", { branch_ref: "foreign" }],
        ["invalid checksum", { plan_checksum: "bad" }],
        ["data-copy ambiguity", { ignored_branch_data: false }],
        ["duplicate pending versions", { pending: [migrationEntry(), migrationEntry()] }],
        ["overlapping pending/applied", { applied: [migrationEntry()] }],
        ["invalid entry checksum", { pending: [migrationEntry({ checksum: "bad" })] }],
        ["fractional statement count", { pending: [migrationEntry({ statement_count: 0.5 })] }],
        ["statement count mismatch", { pending: [migrationEntry({ statement_count: 2 })] }],
        ["empty pending migration", { pending: [migrationEntry({ statement_count: 0, statements: [] })] }],
        ["terminal control in version", { pending: [migrationEntry({ version: "bad\nversion" })] }],
        ["terminal control in name", { pending: [migrationEntry({ name: "bad\u001bname" })] }],
        ["inconsistent safe flag", { safe_to_apply: false }],
        ["inconsistent destructive flag", { requires_destructive_confirmation: true }],
        ["invalid warnings", { warnings: [7] }],
        ["unknown block code", { safe_to_apply: false, blocked: [{ code: "password", version: "202607180001", name: null, message: "secret" }] }],
    ] satisfies Array<[string, Record<string, unknown>]>)("rejects %s plans before reporting success", async (_name, overrides) => {
        const callback = captureBranchTool({ get: async () => ok(promotionPlan(overrides)) });
        const result = await callback({ ...PLAN, json: true });
        expect(result.isError).toBe(true);
        expect(payload(result).error).toEqual({ code: "INVALID_RESPONSE", http_status: 200 });
        expect(text(result)).not.toContain("secret");
    });

    test("requires a reviewed checksum before POST", async () => {
        const callback = captureBranchTool();
        await expect(callback({ action: "promote", branch_ref: "preview" })).rejects.toThrow("plan_checksum");
        await expect(callback({ ...PROMOTE, plan_checksum: "bad" })).rejects.toThrow("SHA-256");
        await expect(callback({ ...PROMOTE, plan_checksum: "A".repeat(64) })).rejects.toThrow("SHA-256");
    });

    test("posts one scoped promotion with reviewed checksum and bounded response", async () => {
        const calls: Array<{ path: string; body: unknown }> = [];
        const callback = captureBranchTool({
            get: async (path, options) => {
                expect(path).toBe("/v1/projects/parent/branches/preview/promote/plan");
                expect(options).toEqual({ maxJsonBytes: 512 * 1024, responseTimeoutMs: 5_000 });
                calls.push({ path, body: null });
                return ok(promotionPlan());
            },
            post: async (path, body, options) => {
                calls.push({ path, body });
                expect(options).toEqual({ maxJsonBytes: 512 * 1024, responseTimeoutMs: 5_000, timeoutMs: 30_000 });
                return ok(promotionResult());
            },
        });
        const result = await callback({ ...PROMOTE, confirm_destructive: true });
        expect(calls).toEqual([{
            path: "/v1/projects/parent/branches/preview/promote/plan",
            body: null,
        }, {
            path: "/v1/projects/parent/branches/preview/promote",
            body: { mode: "migrations", plan_checksum: PLAN_CHECKSUM, confirm_destructive: true },
        }]);
        expect(result.isError).toBeUndefined();
        expect(text(result)).toContain("completed: 1 applied");
        expect(text(result)).toContain("Branch data was not automatically copied");
        expect(text(result)).not.toContain("statements");
    });

    test("returns sanitized JSON success with reviewed and readback checksums kept separate", async () => {
        const callback = captureBranchTool({ post: async () => ok(promotionResult()) });
        const result = await callback({ ...PROMOTE, json: true });
        expect(payload(result)).toMatchObject({
            ok: true, operation: "branch.promote", project_ref: "parent", branch_ref: "preview",
            reviewed_plan_checksum: PLAN_CHECKSUM, plan: { plan_checksum: "c".repeat(64) },
        });
        expect(text(result)).not.toContain("statements");
        expect(text(result)).not.toContain("create table");
    });

    test("skips POST for a scoped, unchanged promotion without fabricating an earlier successful mutation", async () => {
        let reads = 0;
        const callback = captureBranchTool({
            get: async () => {
                reads += 1;
                return ok(promotionPlan({ pending: [], applied: [migrationEntry()] }));
            },
        });
        expect(text(await callback(PROMOTE))).toContain("unchanged");
        const result = await callback({ ...PROMOTE, json: true });
        expect(result.isError).toBeUndefined();
        expect(reads).toBe(2);
        expect(payload(result)).toMatchObject({
            ok: true, promoted: false, unchanged: true, mutation_sent: false,
            project_ref: "parent", branch_ref: "preview", reviewed_plan_checksum: PLAN_CHECKSUM,
            applied: [], plan: { pending: [], applied: [{ version: "202607180001", checksum: MIGRATION_CHECKSUM }] },
            automatic_retry: false,
        });
        expect(text(result)).not.toContain("statements");
    });

    test.each([
        ["changed plan", promotionPlan({ plan_checksum: "d".repeat(64) }), "PLAN_CHANGED"],
        ["changed empty plan", promotionPlan({ plan_checksum: "d".repeat(64), pending: [] }), "PLAN_CHANGED"],
        ["blocked plan", promotionPlan({
            safe_to_apply: false, pending: [],
            blocked: [{ code: "parent_ahead", version: "202607180002", name: null, message: "private" }],
        }), "PLAN_BLOCKED"],
        ["destructive plan", promotionPlan({
            pending: [migrationEntry({ destructive: true })], requires_destructive_confirmation: true,
        }), "DESTRUCTIVE_CONFIRMATION_REQUIRED"],
    ] satisfies Array<[string, Record<string, unknown>, string]>)("preflight stops %s without POST", async (_name, plan, reason) => {
        const callback = captureBranchTool({ get: async () => ok(plan) });
        const result = await callback({ ...PROMOTE, json: true });
        expect(result.isError).toBe(true);
        expect(payload(result)).toMatchObject({
            error: { code: "MUTATION_NOT_SUCCEEDED", http_status: null },
            reason, mutation_sent: false, automatic_retry: false, plan_checksum: PLAN_CHECKSUM,
        });
        expect(text(result)).not.toContain("private");
    });

    test.each([
        ["network", { ok: false, status: 500, transportError: true, data: {} }, "HTTP_ERROR", null],
        ["unavailable", { ok: false, status: 503, data: { error: "private" } }, "HTTP_ERROR", 503],
        ["unreadable", { ok: false, status: 200, responseReadError: true, data: {} }, "HTTP_ERROR", 200],
        ["malformed", ok({}), "INVALID_RESPONSE", 200],
        ["foreign", ok(promotionPlan({ branch_ref: "foreign" })), "INVALID_RESPONSE", 200],
    ] satisfies Array<[string, HttpResult, string, number | null]>)("preflight %s is not an unknown mutation", async (_name, response, code, status) => {
        const callback = captureBranchTool({ get: async () => response });
        const result = await callback({ ...PROMOTE, json: true });
        expect(result.isError).toBe(true);
        expect(payload(result)).toMatchObject({
            error: { code, http_status: status }, mutation_sent: false,
        });
        expect(text(result)).not.toContain("private");
    });

    test("accepts destructive migrations only with reviewed confirmation and matching receipts", async () => {
        const entry = migrationEntry({ destructive: true });
        let writes = 0;
        const callback = captureBranchTool({
            get: async () => ok(promotionPlan({ pending: [entry], requires_destructive_confirmation: true })),
            post: async (_path, body) => {
                writes += 1;
                expect(body).toMatchObject({ confirm_destructive: true, plan_checksum: PLAN_CHECKSUM });
                return ok(promotionResult({ applied: [entry], plan: promotionPlan({ pending: [], applied: [entry] }) }));
            },
        });
        const result = await callback({ ...PROMOTE, confirm_destructive: true, json: true });
        expect(payload(result)).toMatchObject({ ok: true, unchanged: false, mutation_sent: true });
        expect(writes).toBe(1);
    });

    test.each([
        ["missing receipt", {}],
        ["foreign project", promotionResult({ project_ref: "foreign" })],
        ["foreign branch", promotionResult({ branch_ref: "foreign" })],
        ["database replacement", promotionResult({ mode: "replace_database" })],
        ["unconfirmed data isolation", promotionResult({ branch_data_copied: undefined })],
        ["pending readback", promotionResult({ plan: promotionPlan() })],
        ["missing applied readback", promotionResult({ plan: promotionPlan({ pending: [], applied: [] }) })],
        ["different applied checksum", promotionResult({ applied: [migrationEntry({ checksum: "d".repeat(64) })] })],
        ["duplicate applied versions", promotionResult({ applied: [migrationEntry(), migrationEntry()] })],
        ["foreign readback scope", promotionResult({ plan: promotionPlan({ parent_ref: "foreign", pending: [], applied: [migrationEntry()] }) })],
        ["missing reviewed migration", promotionResult({ applied: [] })],
        ["self-consistent unrelated migration", promotionResult({
            applied: [migrationEntry({ version: "202607180999" })],
            plan: promotionPlan({ pending: [], applied: [migrationEntry({ version: "202607180999" })] }),
        })],
        ["additional migration", promotionResult({
            applied: [migrationEntry(), migrationEntry({ version: "202607180999" })],
            plan: promotionPlan({ pending: [], applied: [migrationEntry(), migrationEntry({ version: "202607180999" })] }),
        })],
        ["self-consistent changed checksum", promotionResult({
            applied: [migrationEntry({ checksum: "d".repeat(64) })],
            plan: promotionPlan({ pending: [], applied: [migrationEntry({ checksum: "d".repeat(64) })] }),
        })],
    ] satisfies Array<[string, Record<string, unknown>]>)("treats %s 2xx receipts as unknown, never replaying POST", async (_name, body) => {
        let calls = 0;
        const callback = captureBranchTool({
            post: async () => { calls += 1; return ok(body); },
        });
        const result = await callback({ ...PROMOTE, json: true });
        expect(calls).toBe(1);
        expect(result.isError).toBe(true);
        expect(payload(result)).toMatchObject({
            error: { code: "OUTCOME_UNKNOWN", http_status: 200 },
            automatic_retry: false, project_ref: "parent", branch_ref: "preview", plan_checksum: PLAN_CHECKSUM,
            reconciliation: { action: "promotion_plan", ref: "parent", branch_ref: "preview" },
        });
    });

    test.each([
        ["network timeout", 500, { transportError: true }, null],
        ["read failure after 200", 200, { responseReadError: true }, 200],
        ["read failure after 400", 400, { responseReadError: true }, 400],
        ["server timeout", 408, {}, 408],
        ["server error", 503, {}, 503],
    ] satisfies Array<[string, number, Partial<HttpResult>, number | null]>)("retains identity for %s without reflecting errors", async (_name, status, flags, expectedStatus) => {
        let calls = 0;
        const callback = captureBranchTool({
            post: async () => {
                calls += 1;
                return { ok: false, status, ...flags, data: { error: "password=secret", code: "secret", statements: ["drop table accounts"] } };
            },
        });
        const result = await callback({ ...PROMOTE, json: true });
        expect(calls).toBe(1);
        expect(payload(result)).toMatchObject({
            error: { code: "OUTCOME_UNKNOWN", http_status: expectedStatus },
            plan_checksum: PLAN_CHECKSUM, automatic_retry: false,
        });
        expect(text(result)).not.toContain("secret");
        expect(text(result)).not.toContain("drop table");
    });

    test("preserves partial versions as reported, not verified, evidence", async () => {
        const callback = captureBranchTool({
            post: async () => ({
                ok: false, status: 500,
                data: { error: "password=secret", code: "promotion_readback_failed", applied: [migrationEntry()] },
            }),
        });
        const result = await callback(PROMOTE);
        expect(result.isError).toBe(true);
        expect(text(result)).toContain("outcome is unknown");
        expect(text(result)).toContain("Server-reported applied versions: 202607180001");
        expect(text(result)).toContain("fresh promotion_plan");
        expect(text(result)).not.toContain("secret");
        expect(text(result)).not.toContain("create table");
    });

    test("does not expose malformed partial evidence", async () => {
        const callback = captureBranchTool({
            post: async () => ({
                ok: false, status: 500,
                data: { applied: [migrationEntry({ version: "secret\nversion" })] },
            }),
        });
        const result = await callback({ ...PROMOTE, json: true });
        expect(payload(result).reported_applied_versions).toEqual([]);
        expect(text(result)).not.toContain("secret");
    });

    test("reports typed conflicts without claiming that no migrations were applied", async () => {
        const callback = captureBranchTool({
            post: async () => ({
                ok: false, status: 409,
                data: { code: "promotion_plan_changed", error: "password=secret", applied: [migrationEntry()] },
            }),
        });
        const result = await callback({ ...PROMOTE, json: true });
        expect(payload(result)).toMatchObject({
            error: { code: "HTTP_ERROR", http_status: 409 },
            server_code: "promotion_plan_changed", reported_applied_versions: ["202607180001"],
        });
        expect(text(result)).not.toContain("secret");
    });

    test("plan errors are not classified as failed mutations and do not leak bodies", async () => {
        const callback = captureBranchTool({
            get: async () => ({ ok: false, status: 500, data: { error: "password=secret" } }),
        });
        const result = await callback({ ...PLAN, json: true });
        expect(payload(result).error).toEqual({ code: "HTTP_ERROR", http_status: 500 });
        expect(text(result)).not.toContain("secret");
    });

    test("encodes promotion scope and validates the same override scope", async () => {
        const callback = captureBranchTool({
            get: async (path) => {
                expect(path).toBe("/v1/projects/other%2Fproject/branches/other%2Fpreview/promote/plan");
                return ok(promotionPlan({ parent_ref: "other/project", branch_ref: "other/preview" }));
            },
        });
        expect((await callback({ ...PLAN, ref: "other/project", branch_ref: "other/preview" })).isError).toBeUndefined();
    });

    test("blocks read-only writes without invoking transport, including JSON", async () => {
        const callback = captureBranchTool({}, { projectRef: "parent", readOnly: true });
        expect(text(await callback(PROMOTE))).toContain("read-only");
        const result = await callback({ ...PROMOTE, json: true });
        expect(result.isError).toBe(true);
        expect(payload(result)).toMatchObject({ ok: false, reason: "READ_ONLY", operation: "branch.promote" });
    });

    test("CLI json emits one receipt on stdout and a nonzero unknown-outcome exit code", async () => {
        const tools: Record<string, { schema: ToolSchema; callback: ToolInvocation }> = {};
        registerBranchTools({
            tool(name, _description, schema, callback) { tools[name] = { schema, callback }; },
        }, mockHttp({
            get: async () => ok(promotionPlan()),
            post: async () => ({ ok: false, status: 503, data: { error: "password=secret" } }),
        }), { projectRef: "parent" });
        const stdout = spyOn(console, "log").mockImplementation(() => undefined);
        const stderr = spyOn(console, "error").mockImplementation(() => undefined);
        try {
            await runCli(tools, ["branch", "promote", "--branch_ref", "preview", "--plan_checksum", PLAN_CHECKSUM, "--json"]);
            expect(stdout).toHaveBeenCalledTimes(1);
            const output: unknown = stdout.mock.calls[0]?.[0];
            expect(typeof output).toBe("string");
            expect(JSON.parse(String(output))).toMatchObject({
                ok: false, operation: "branch.promote",
                error: { code: "OUTCOME_UNKNOWN", http_status: 503 },
                plan_checksum: PLAN_CHECKSUM,
            });
            expect(String(output)).not.toContain("secret");
            expect(stderr).toHaveBeenCalledTimes(1);
            expect(String(stderr.mock.calls[0]?.[0])).toContain("OUTCOME_UNKNOWN");
            expect(process.exitCode).toBe(1);
        } finally {
            stdout.mockRestore();
            stderr.mockRestore();
            process.exitCode = 0;
        }
    });

    test.each(["list", "create", "delete"])("preserves non-promotion %s behavior", async (action) => {
        const response = ok({ action });
        const callback = captureBranchTool({
            get: async () => response, post: async () => response, delete: async () => response,
        });
        expect(text(await callback({ action, branch_ref: "preview", name: "feature" }))).toBe(JSON.stringify(response.data, null, 2));
    });

    test("a non-promotion list failure does not require branch_ref", async () => {
        const callback = captureBranchTool({
            get: async () => ({ ok: false, status: 404, data: { error: "Project not found" } }),
        });
        const result = await callback({ action: "list", ref: "other/project" });
        expect(result.isError).toBe(true);
        expect(text(result)).toContain("Project not found");
    });

    test.each([
        ["malformed JSON", "not-json", 200],
        ["oversized JSON", JSON.stringify({ extra: "x".repeat(512 * 1024) }), 200],
        ["server unavailable", JSON.stringify({ error: "password=secret" }), 503],
    ] satisfies Array<[string, string, number]>)("actual HTTP %s fails closed with one POST", async (_name, body, status) => {
        let calls = 0;
        let reads = 0;
        const server = Bun.serve({
            hostname: "127.0.0.1", port: 0,
            fetch(request) {
                if (request.method === "GET") {
                    reads += 1;
                    return Response.json(promotionPlan());
                }
                calls += 1;
                return new Response(body, { status, headers: { "content-type": "application/json" } });
            },
        });
        try {
            const callback = register(new HttpTransport({ baseUrl: server.url.toString(), token: "local-test" }));
            const result = await callback({ ...PROMOTE, json: true });
            expect(calls).toBe(1);
            expect(reads).toBe(1);
            expect(result.isError).toBe(true);
            expect(payload(result).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: status });
            expect(text(result)).not.toContain("secret");
        } finally {
            await server.stop(true);
        }
    });

    test("actual HTTP no-op performs only one plan GET", async () => {
        const requests: string[] = [];
        const server = Bun.serve({
            hostname: "127.0.0.1", port: 0,
            fetch(request) {
                requests.push(`${request.method} ${new URL(request.url).pathname}`);
                return Response.json(promotionPlan({ pending: [], applied: [migrationEntry()] }));
            },
        });
        try {
            const callback = register(new HttpTransport({ baseUrl: server.url.toString(), token: "local-test" }));
            expect(payload(await callback({ ...PROMOTE, json: true }))).toMatchObject({
                ok: true, unchanged: true, promoted: false, mutation_sent: false,
            });
            expect(requests).toEqual(["GET /v1/projects/parent/branches/preview/promote/plan"]);
        } finally {
            await server.stop(true);
        }
    });
});
