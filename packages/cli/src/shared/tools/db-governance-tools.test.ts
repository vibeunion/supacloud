import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseModule, QueryExecutor } from "@supacloud/db";
import { executionMode } from "../execution-policy";
import {
    loadDatabaseModules,
    registerDbGovernanceTools,
    runModuleCheck,
    type DbToolArguments,
} from "./db-governance-tools";

type DbCallback = (args: Partial<DbToolArguments>) => Promise<{
    isError: boolean;
    content: Array<{ type: "text"; text: string }>;
}>;

function captureDbCallback(environment: NodeJS.ProcessEnv = {}): DbCallback {
    let callback: DbCallback | undefined;
    registerDbGovernanceTools({
        tool(_name, _description, _schema, registered) {
            callback = registered as DbCallback;
        },
    }, { environment });
    if (!callback) throw new Error("db tool was not registered");
    return callback;
}

const MODULES_SOURCE = `export default [
  {
    name: "cases",
    tables: ["public.cases"],
    policies: [
      {
        name: "cases_select",
        table: "public.cases",
        operation: "select",
        roles: ["authenticated"],
        source: "db/policies/cases_select.sql",
      },
    ],
    functions: [
      {
        name: "public.case_create",
        source: "db/functions/case_create.sql",
        security: "definer",
        permission: "case.create",
        transaction: "required",
        audit: "case.created",
      },
    ],
    triggers: [],
    grants: [
      { object: "public.cases", privilege: "select", role: "authenticated", source: "db/grants/cases.sql" },
    ],
  },
  {
    name: "clean",
    tables: ["public.clean"],
    policies: [
      {
        name: "clean_select",
        table: "public.clean",
        operation: "select",
        roles: ["authenticated"],
        source: "db/policies/clean_select.sql",
        tests: ["tests/clean_select.sql"],
      },
    ],
    functions: [],
    triggers: [],
    grants: [],
  },
];
`;

const FIXTURE_FILES: Record<string, string> = {
    "db/modules.ts": MODULES_SOURCE,
    "db/policies/cases_select.sql": `alter table public.cases enable row level security;
create policy cases_select on public.cases for select to authenticated using (true);
`,
    // security definer without search_path set -> definer-no-search-path error
    "db/functions/case_create.sql": `create or replace function public.case_create()
returns void language plpgsql security definer as $$ begin end; $$;
`,
   "db/grants/cases.sql": `grant select on public.cases to authenticated;
`,
    "db/policies/clean_select.sql": `alter table public.clean enable row level security;
drop policy if exists clean_select on public.clean;
create policy clean_select on public.clean for select to authenticated using (true);
`,
    // For loader boundary testing: must write to disk before any same-directory import occurs (Bun caches directory listings)
    "db/single.ts": `export const modules = { name: "solo" };\n`,
    "db/invalid.ts": `export default 42;\n`,
};

/** Mock executor dispatched based on catalog SQL text. */
function mockExecutor(overrides: { policies?: unknown[] } = {}): QueryExecutor {
    return {
        async query<T>(sql: string): Promise<T[]> {
            if (sql.includes("FROM pg_policy")) {
                return (overrides.policies ?? [{
                    schema: "public", table: "cases", name: "cases_select",
                    command: "r", roles: ["authenticated"], using_expr: "true", check_expr: null,
                }]) as T[];
            }
            if (sql.includes("FROM pg_proc")) {
                return [{
                    schema: "public", name: "case_create",
                    security_definer: true, config: ["search_path=public"], language: "plpgsql",
                }] as T[];
            }
            if (sql.includes("role_table_grants")) {
                return [{
                    object_schema: "public", object_name: "cases",
                    privilege: "SELECT", grantee: "authenticated",
                }] as T[];
            }
            return [{ schema: "public", name: "cases", rls_enabled: true, rls_forced: false }] as T[];
        },
    };
}

const CASES_MODULE: DatabaseModule = {
    name: "cases",
    tables: ["public.cases"],
    policies: [{
        name: "cases_select", table: "public.cases", operation: "select",
        roles: ["authenticated"], source: "db/policies/cases_select.sql",
    }],
    functions: [{
        name: "public.case_create", source: "db/functions/case_create.sql", security: "definer",
    }],
    triggers: [],
    grants: [{ object: "public.cases", privilege: "select", role: "authenticated", source: "db/grants/cases.sql" }],
};

describe("db governance tools", () => {
    let root: string;
    const db = captureDbCallback();

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), "supacloud-db-tools-"));
        for (const [relativePath, content] of Object.entries(FIXTURE_FILES)) {
            const absolute = join(root, relativePath);
            mkdirSync(dirname(absolute), { recursive: true });
            writeFileSync(absolute, content, "utf8");
        }
    });

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    test("loadDatabaseModules resolves default/named exports and validates shape", async () => {
        const modules = await loadDatabaseModules(root);
        expect(modules.map((module) => module.name)).toEqual(["cases", "clean"]);

        const single = join(root, "db/single.ts");
        expect(existsSync(single)).toBe(true);
        const [solo] = await loadDatabaseModules(root, "db/single.ts");
        expect(solo).toEqual({
            name: "solo", tables: [], policies: [], functions: [], triggers: [], grants: [],
        });

        await expect(loadDatabaseModules(root, "db/invalid.ts")).rejects.toThrow("Invalid database module");
        await expect(loadDatabaseModules(root, "db/missing.ts")).rejects.toThrow("Module file not found");
    });

    test("lint reports error-level issues and exits as error", async () => {
        const result = await db({ action: "lint", root });
        expect(result.isError).toBe(true);
        const text = result.content[0].text;
        expect(text).toContain("linted 2 module(s): cases, clean");
        expect(text).toContain("error definer-no-search-path db/functions/case_create.sql:2");
        expect(text).toContain("warn policy-without-test");
    });

    test("lint --module filters to a single clean module", async () => {
        const result = await db({ action: "lint", root, module: "clean" });
        expect(result.isError).toBe(false);
        expect(result.content[0].text).toContain("linted 1 module(s): clean");
        expect(result.content[0].text).toContain("no issues");

        await expect(db({ action: "lint", root, module: "nope" }))
            .rejects.toThrow("未找到数据库模块: nope");
    });

    test("explain renders objects and flags unknown targets", async () => {
        const policy = await db({ action: "explain", root, target: "cases_select" });
        expect(policy.isError).toBe(false);
        expect(policy.content[0].text).toContain("类型: 策略 (policy)");
        expect(policy.content[0].text).toContain("所属模块: cases");

        const fn = await db({ action: "explain", root, target: "public.case_create" });
        expect(fn.content[0].text).toContain("类型: 函数 (function)");
        expect(fn.content[0].text).toContain("权限: case.create");

        const table = await db({ action: "explain", root, target: "public.cases" });
        expect(table.content[0].text).toContain("类型: 表 (table)");

        const missing = await db({ action: "explain", root, target: "public.nope" });
        expect(missing.isError).toBe(true);
        expect(missing.content[0].text).toContain("未找到对象");
    });

    test("runModuleCheck reconciles declared state against a mocked catalog", async () => {
        const okReport = await runModuleCheck(CASES_MODULE, mockExecutor(), ["public"]);
        expect(okReport.ok).toBe(true);
        expect(okReport.issues).toEqual([]);

        const driftReport = await runModuleCheck(CASES_MODULE, mockExecutor({ policies: [] }), ["public"]);
        expect(driftReport.ok).toBe(false);
        expect(driftReport.issues.some((issue) =>
            issue.severity === "error" && issue.code === "missing-policy"
        )).toBe(true);
    });

    test("module_check requires a database URL", async () => {
        await expect(db({ action: "module_check", root, module_file: "db/modules.ts" }))
            .rejects.toThrow("--database_url");

        const withEnv = captureDbCallback({ DATABASE_URL: "postgresql://127.0.0.1:1/nope" });
        // URL exists but cannot connect -> clear connection error instead of raw exception
        await expect(withEnv({ action: "module_check", root, module_file: "db/modules.ts" }))
            .rejects.toThrow("无法读取数据库 catalog");
    });

    test("module_check --lite delegates to supacloud-lite db check", async () => {
        const calls: string[][] = [];
        let callback: DbCallback | undefined;
        registerDbGovernanceTools({
            tool(_name, _description, _schema, registered) {
                callback = registered as DbCallback;
            },
        }, {
            environment: {},
            liteBinary: "/fake/supacloud-lite",
            liteSpawn: async (command) => {
                calls.push(command);
                return { exitCode: 0, stdout: "module docs:\n  ok\n", stderr: "" };
            },
        });
        if (!callback) throw new Error("db tool was not registered");

        const result = await callback({ action: "module_check", root, lite: true });
        expect(result.isError).toBe(false);
        expect(result.content[0].text).toContain("module docs:");
        expect(calls).toHaveLength(1);
        expect(calls[0].slice(0, 3)).toEqual(["/fake/supacloud-lite", "db", "check"]);
        expect(calls[0]).toContain("--project-dir");
        expect(calls[0]).toContain(root);
    });

    test("module_check --lite propagates a failing exit code and module_file", async () => {
        const calls: string[][] = [];
        let callback: DbCallback | undefined;
        registerDbGovernanceTools({
            tool(_name, _description, _schema, registered) {
                callback = registered as DbCallback;
            },
        }, {
            environment: {},
            liteBinary: "/fake/supacloud-lite",
            liteSpawn: async (command) => {
                calls.push(command);
                return { exitCode: 1, stdout: "missing-policy here\n", stderr: "" };
            },
        });
        if (!callback) throw new Error("db tool was not registered");

        const result = await callback({ action: "module_check", root, lite: true, module_file: "db/modules.ts" });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("missing-policy");
        expect(calls[0]).toContain("--module-file");
    });

    test("module_check --lite requires the supacloud-lite binary", async () => {
        let callback: DbCallback | undefined;
        registerDbGovernanceTools({
            tool(_name, _description, _schema, registered) {
                callback = registered as DbCallback;
            },
        }, {
            environment: {},
            liteBinary: null,
            liteSpawn: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        });
        if (!callback) throw new Error("db tool was not registered");

        await expect(callback({ action: "module_check", root, lite: true }))
            .rejects.toThrow("supacloud-lite");
    });

    test("db actions are classified in the execution policy", () => {
        expect(executionMode("db", "lint", {})).toBe("local");
        expect(executionMode("db", "explain", {})).toBe("local");
        expect(executionMode("db", "module_check", {})).toBe("read");
    });
});
