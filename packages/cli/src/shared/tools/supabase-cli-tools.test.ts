import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
    buildOfficialSupabaseArgs,
    createOfficialSupabaseEnvironment,
    redactOfficialSupabaseOutput,
    registerSupabaseCliTools,
    resolveOfficialSupabaseCommand,
} from "./supabase-cli-tools";

describe("official Supabase CLI adapter", () => {
    test("maps local migration authoring to an argv allowlist", () => {
        expect(buildOfficialSupabaseArgs({
            action: "migration_new",
            name: "add_accounts",
            workdir: "/workspace/project",
        })).toEqual([
            "migration", "new", "add_accounts",
            "--workdir", "/workspace/project",
        ]);

        expect(buildOfficialSupabaseArgs({
            action: "db_reset",
            no_seed: true,
            workdir: "/workspace/project",
        })).toEqual([
            "db", "reset", "--local", "--no-seed", "--yes",
            "--workdir", "/workspace/project",
        ]);
    });

    test("builds current official CLI syntax for remote pull, dump, list, and type generation", () => {
        const dbUrl = "postgresql://postgres:secret@db.example.com:5432/postgres";

        expect(buildOfficialSupabaseArgs({
            action: "db_pull",
            db_url: dbUrl,
            declarative: true,
            schema: "public,auth",
            name: "remote_schema",
            workdir: "/workspace/project",
        })).toEqual([
            "db", "pull", "remote_schema", "--db-url", dbUrl,
            "--declarative", "--schema", "public,auth",
            "--workdir", "/workspace/project",
        ]);

        expect(buildOfficialSupabaseArgs({
            action: "db_dump",
            db_url: dbUrl,
            file: "backups/schema.sql",
            schema: "public",
            workdir: "/workspace/project",
        })).toEqual([
            "db", "dump", "--db-url", dbUrl,
            "--file", "/workspace/project/backups/schema.sql",
            "--schema", "public",
            "--workdir", "/workspace/project",
        ]);

        expect(buildOfficialSupabaseArgs({
            action: "migration_list",
            db_url: dbUrl,
            workdir: "/workspace/project",
        })).toEqual([
            "migration", "list", "--db-url", dbUrl,
            "--workdir", "/workspace/project",
        ]);

        expect(buildOfficialSupabaseArgs({
            action: "gen_types",
            db_url: dbUrl,
            language: "typescript",
            schema: "public,auth",
            file: "src/database.types.ts",
            workdir: "/workspace/project",
        })).toEqual([
            "gen", "types", "--db-url", dbUrl,
            "--lang", "typescript", "--schema", "public,auth",
            "--workdir", "/workspace/project",
        ]);
    });

    test("rejects invalid names, schemas, database URLs, and remote reset attempts", () => {
        expect(() => buildOfficialSupabaseArgs({
            action: "migration_new",
            name: "bad name; rm -rf /",
            workdir: "/workspace/project",
        })).toThrow("Invalid migration name");

        expect(() => buildOfficialSupabaseArgs({
            action: "db_pull",
            db_url: "https://example.com/not-postgres",
            workdir: "/workspace/project",
        })).toThrow("Postgres database URL");

        expect(() => buildOfficialSupabaseArgs({
            action: "db_diff",
            schema: "public;drop schema auth",
            workdir: "/workspace/project",
        })).toThrow("Invalid schema list");

        expect(() => buildOfficialSupabaseArgs({
            action: "db_pull",
            db_url: "postgresql://postgres:secret@db.example.com/postgres",
            diff_engine: "pgadmin",
            workdir: "/workspace/project",
        })).toThrow("db_pull only supports");

        expect(buildOfficialSupabaseArgs({
            action: "db_reset",
            db_url: "postgresql://postgres:secret@db.example.com/postgres",
            workdir: "/workspace/project",
        } as any)).not.toContain("--db-url");
    });

    test("does not forward control-plane or database secrets to the official CLI", () => {
        const environment = createOfficialSupabaseEnvironment({
            PATH: "/usr/bin",
            HOME: "/Users/test",
            LANG: "en_US.UTF-8",
            SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
            SUPACLOUD_API_TOKEN: "management-secret",
            SUPABASE_ACCESS_TOKEN: "upstream-access-secret",
            DATABASE_URL: "postgresql://postgres:password@localhost/postgres",
            PGPASSWORD: "postgres-password",
            PGPASSFILE: "/Users/test/.pgpass",
            AUTHORIZATION: "Bearer hidden",
            CUSTOM_SECRET: "custom-secret",
        });

        expect(environment.PATH).toBe("/usr/bin");
        expect(environment.HOME).toBe("/Users/test");
        expect(environment.LANG).toBe("en_US.UTF-8");
        expect(environment.SUPABASE_TELEMETRY_DISABLED).toBe("true");
        expect(environment.NO_COLOR).toBe("1");
        expect(environment.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
        expect(environment.SUPACLOUD_API_TOKEN).toBeUndefined();
        expect(environment.SUPABASE_ACCESS_TOKEN).toBeUndefined();
        expect(environment.DATABASE_URL).toBeUndefined();
        expect(environment.PGPASSWORD).toBeUndefined();
        expect(environment.PGPASSFILE).toBeUndefined();
        expect(environment.AUTHORIZATION).toBeUndefined();
        expect(environment.CUSTOM_SECRET).toBeUndefined();
    });

    test("redacts explicit and discovered connection credentials from output", () => {
        const dbUrl = "postgresql://postgres:top-secret@db.example.com/postgres";
        const output = [
            `failed command: supabase db pull --db-url ${dbUrl}`,
            "DATABASE_URL=postgres://admin:other-secret@localhost/app",
            "SUPABASE_SERVICE_ROLE_KEY=service-secret",
        ].join("\n");

        const redacted = redactOfficialSupabaseOutput(output, [dbUrl, "service-secret"]);
        expect(redacted).not.toContain("top-secret");
        expect(redacted).not.toContain("other-secret");
        expect(redacted).not.toContain("service-secret");
        expect(redacted).toContain("[REDACTED]");
    });

    test("uses an explicit executable or pinned package runner without shell parsing", () => {
        expect(resolveOfficialSupabaseCommand("/workspace/project", {
            SUPACLOUD_SUPABASE_CLI_BIN: "/opt/bin/supabase",
        })).toEqual(["/opt/bin/supabase"]);

        expect(resolveOfficialSupabaseCommand("/workspace/project", {
            SUPABASE_CLI_VERSION: "2.110.0",
        })).toEqual([process.execPath, "x", "supabase@2.110.0"]);

        expect(() => resolveOfficialSupabaseCommand("/workspace/project", {
            SUPABASE_CLI_VERSION: "latest; echo unsafe",
        })).toThrow("Invalid SUPABASE_CLI_VERSION");
    });

    test("routes push through the configured Management migration callback", async () => {
        let registered: { callback: (args: any) => Promise<any> } | undefined;
        let pushedArgs: Record<string, unknown> | undefined;
        let officialExecutions = 0;

        registerSupabaseCliTools({
            tool(_name, _description, _schema, callback) {
                registered = { callback };
            },
        }, {
            getPushMigrations: () => async (args) => {
                pushedArgs = args;
                return { content: [{ type: "text", text: "dry run ok" }] };
            },
            executeOfficialCli: async () => {
                officialExecutions += 1;
                return { exitCode: 0, stdout: "", stderr: "" };
            },
        });

        const result = await registered!.callback({
            action: "push",
            ref: "project-a",
            dir: "supabase/migrations",
            dry_run: true,
            workdir: process.cwd(),
        });

        expect(pushedArgs).toEqual({
            action: "push_migrations",
            ref: "project-a",
            dir: resolve(process.cwd(), "supabase/migrations"),
            dry_run: true,
        });
        expect(officialExecutions).toBe(0);
        expect(result.content[0].text).toBe("dry run ok");
    });

    test("preserves a non-zero CLI contract when the migration API reports failure text", async () => {
        let registered: { callback: (args: any) => Promise<any> } | undefined;
        registerSupabaseCliTools({
            tool(_name, _description, _schema, callback) {
                registered = { callback };
            },
        }, {
            projectRef: "project-a",
            getPushMigrations: () => async () => ({
                content: [{ type: "text", text: "❌ Failed (500): database unavailable" }],
            }),
        });

        const response = await registered!.callback({ action: "push" });

        expect(response.isError).toBe(true);
        expect(response.content[0].text).toContain("database unavailable");
    });

    test("blocks migration push before callback dispatch in read-only mode", async () => {
        let registered: { callback: (args: any) => Promise<any> } | undefined;
        let pushCalls = 0;
        registerSupabaseCliTools({
            tool(_name, _description, _schema, callback) {
                registered = { callback };
            },
        }, {
            readOnly: true,
            getPushMigrations: () => async () => {
                pushCalls += 1;
                return { content: [{ type: "text", text: "should not run" }] };
            },
        });

        const response = await registered!.callback({ action: "push" });

        expect(response.isError).toBe(true);
        expect(response.content[0].text).toContain("read-only");
        expect(pushCalls).toBe(0);
    });
});
