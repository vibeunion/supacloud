import { describe, expect, test } from "bun:test";
import type { ToolSchema } from "../schema";
import { registerBranchTools } from "./branch-tools";

type Callback = (args: Record<string, unknown>) => Promise<{
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
}>;

function captureBranchTool(
    http: Record<string, (...args: any[]) => Promise<any>>,
    options: { projectRef?: string; readOnly?: boolean } = { projectRef: "parent" },
) {
    let callback: Callback | undefined;
    registerBranchTools({
        tool(name: string, _description: string, _schema: ToolSchema, toolCallback: Callback) {
            if (name === "branch") callback = toolCallback;
        },
    } as any, http as any, options);
    if (!callback) throw new Error("branch tool was not registered");
    return callback;
}

describe("branch CLI tool", () => {
    test("renders a migration promotion plan without exposing SQL", async () => {
        const callback = captureBranchTool({
            get: async () => ({
                ok: true,
                status: 200,
                data: {
                    mode: "migrations",
                    safe_to_apply: true,
                    plan_checksum: "a".repeat(64),
                    pending: [{ version: "202607180001", name: "add_accounts", checksum: "b".repeat(64), statement_count: 1, statements: ["create table accounts(id bigint)"], destructive: false }],
                    applied: [],
                    blocked: [],
                    warnings: [],
                    requires_destructive_confirmation: false,
                    ignored_branch_data: true,
                },
            }),
        });

        const result = await callback({ action: "promotion_plan", branch_ref: "preview" });

        expect(result.content[0].text).toContain("add_accounts");
        expect(result.content[0].text).toContain("Branch data will not be automatically copied");
        expect(result.content[0].text).not.toContain("create table");
    });

    test("requires a reviewed plan checksum before applying migrations", async () => {
        const callback = captureBranchTool({ post: async () => ({ ok: true, status: 200, data: {} }) });
        await expect(callback({ action: "promote", branch_ref: "preview" })).rejects.toThrow("plan_checksum");
    });

    test("posts safe migration promotion with the reviewed checksum", async () => {
        const calls: Array<{ path: string; body: unknown }> = [];
        const callback = captureBranchTool({
            post: async (path: string, body: unknown) => {
                calls.push({ path, body });
                return { ok: true, status: 200, data: { promoted: true, applied: [] } };
            },
        });

        const result = await callback({
            action: "promote",
            branch_ref: "preview",
            plan_checksum: "a".repeat(64),
            confirm_destructive: true,
        });

        expect(calls).toEqual([{
            path: "/v1/projects/parent/branches/preview/promote",
            body: {
                mode: "migrations",
                plan_checksum: "a".repeat(64),
                confirm_destructive: true,
            },
        }]);
        expect(result.content[0].text).toContain("Branch data was not automatically copied");
        expect(result.content[0].text).not.toContain("statements");
    });

    test("explicit ref overrides context and URL path values are encoded", async () => {
        const calls: string[] = [];
        const callback = captureBranchTool({
            get: async (path: string) => {
                calls.push(path);
                return { ok: true, status: 200, data: { branches: [] } };
            },
        });

        await callback({ action: "list", ref: "other/project" });

        expect(calls).toEqual(["/v1/projects/other%2Fproject/branches"]);
    });

    test("reports partial application evidence without printing SQL", async () => {
        const callback = captureBranchTool({
            post: async () => ({
                ok: false,
                status: 500,
                data: {
                    error: "read-back failed",
                    applied: [{ version: "202607180001", statements: ["drop table accounts"] }],
                },
            }),
        });

        const result = await callback({
            action: "promote",
            branch_ref: "preview",
            plan_checksum: "a".repeat(64),
        });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Applied before failure: 202607180001");
        expect(result.content[0].text).toContain("fresh promotion_plan");
        expect(result.content[0].text).not.toContain("drop table");
    });

    test("blocks branch writes in read-only mode", async () => {
        const callback = captureBranchTool({}, { projectRef: "parent", readOnly: true });
        const result = await callback({ action: "promote", branch_ref: "preview", plan_checksum: "a".repeat(64) });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("read-only");
    });
});
