import { describe, expect, test } from "bun:test";
import {
    analyzeMigrationFiles,
    analyzeMigrationSql,
    formatMigrationRiskReport,
} from "./migration-risk";

describe("migration risk analysis", () => {
    test("detects safe additive migrations as LOW risk", () => {
        const sql = `
            CREATE TABLE public.posts (
                id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
                title text NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now()
            );
            ALTER TABLE public.posts ADD CONSTRAINT fk_user FOREIGN KEY (author_id) REFERENCES public.users(id) NOT VALID;
            ALTER TABLE public.posts ADD CONSTRAINT chk_title CHECK (length(title) > 0) NOT VALID;
        `;
        const risks = analyzeMigrationSql(sql);
        expect(risks).toHaveLength(0);

        const analysis = analyzeMigrationFiles([{ file: "20260819_add_posts.sql", sql }]);
        expect(analysis.overallRisk).toBe("LOW");
        expect(analysis.highRiskCount).toBe(0);
        expect(analysis.mediumRiskCount).toBe(0);
        expect(formatMigrationRiskReport(analysis)).toContain("✅ All migrations follow safe, non-blocking Expand-Contract patterns.");
    });

    test("detects non-concurrent index creation as MEDIUM risk", () => {
        const sql = `CREATE INDEX idx_users_email ON public.users (email);`;
        const risks = analyzeMigrationSql(sql);
        expect(risks).toEqual([
            expect.objectContaining({
                level: "MEDIUM",
                type: "locking_non_concurrent_index",
            }),
        ]);
        expect(risks[0].recommendation).toContain("CREATE INDEX CONCURRENTLY");
    });

    test("detects non-concurrent drop index as MEDIUM risk", () => {
        const sql = `DROP INDEX idx_users_old;`;
        const risks = analyzeMigrationSql(sql);
        expect(risks).toEqual([
            expect.objectContaining({
                level: "MEDIUM",
                type: "locking_drop_index_non_concurrent",
            }),
        ]);
        expect(risks[0].recommendation).toContain("DROP INDEX CONCURRENTLY");
    });

    test("blocks concurrent index operations in the transactional push executor", () => {
        const sql = `
            CREATE INDEX CONCURRENTLY idx_users_email ON public.users (email);
            CREATE UNIQUE INDEX CONCURRENTLY idx_users_name ON public.users (name);
            DROP INDEX CONCURRENTLY idx_users_legacy;
        `;
        const risks = analyzeMigrationSql(sql);
        expect(risks).toHaveLength(3);
        expect(risks.every((risk) => risk.type === "unsupported_concurrent_index_migration")).toBe(true);
        expect(risks.every((risk) => risk.blocksTransactionalPush === true)).toBe(true);

        const analysis = analyzeMigrationFiles([{ file: "concurrent.sql", sql }]);
        expect(analysis.transactionalPushBlockerCount).toBe(3);
    });

    test("detects ADD COLUMN NOT NULL without DEFAULT as MEDIUM risk", () => {
        const sql = `ALTER TABLE public.users ADD COLUMN status text NOT NULL;`;
        const risks = analyzeMigrationSql(sql);
        expect(risks).toEqual([
            expect.objectContaining({
                level: "MEDIUM",
                type: "locking_not_null_no_default",
            }),
        ]);
        expect(risks[0].recommendation).toContain("Expand-Contract");
    });

    test("does not flag ADD COLUMN NOT NULL with DEFAULT", () => {
        expect(analyzeMigrationSql(
            `ALTER TABLE public.users ADD COLUMN status text NOT NULL DEFAULT 'active';`,
        )).toHaveLength(0);
        expect(analyzeMigrationSql(
            `ALTER TABLE public.users ADD COLUMN attempts integer DEFAULT 1 NOT NULL;`,
        )).toHaveLength(0);
    });

    test("analyzes each ALTER TABLE subcommand independently", () => {
        const risks = analyzeMigrationSql(`
            ALTER TABLE public.users
              ADD COLUMN safe_count integer DEFAULT 0,
              ADD COLUMN required_label text NOT NULL;
        `);
        expect(risks).toEqual([
            expect.objectContaining({
                type: "locking_not_null_no_default",
                statementSnippet: expect.stringContaining("required_label"),
            }),
        ]);
    });

    test("flags function-based defaults conservatively but allows known stable timestamps", () => {
        expect(analyzeMigrationSql(
            "ALTER TABLE users ADD COLUMN request_id uuid DEFAULT gen_random_uuid() NOT NULL;",
        )).toEqual([
            expect.objectContaining({ type: "locking_not_null_expression_default" }),
        ]);
        expect(analyzeMigrationSql(
            "ALTER TABLE users ADD COLUMN created_at timestamptz DEFAULT now() NOT NULL;",
        )).toHaveLength(0);
    });

    test("detects destructive DROP TABLE and DROP VIEW as HIGH risk", () => {
        expect(analyzeMigrationSql("DROP TABLE public.legacy_logs;")).toEqual([
            expect.objectContaining({ level: "HIGH", type: "destructive_drop_table" }),
        ]);
        expect(analyzeMigrationSql("DROP VIEW public.active_users;")).toEqual([
            expect.objectContaining({ level: "HIGH", type: "destructive_drop_view" }),
        ]);
        expect(analyzeMigrationSql("DROP MATERIALIZED VIEW public.monthly_stats;")).toEqual([
            expect.objectContaining({ level: "HIGH", type: "destructive_drop_view" }),
        ]);
    });

    test("detects destructive DROP COLUMN as HIGH risk", () => {
        const sql = `ALTER TABLE public.users DROP COLUMN deprecated_field;`;
        const risks = analyzeMigrationSql(sql);
        expect(risks).toEqual([
            expect.objectContaining({
                level: "HIGH",
                type: "destructive_drop_column",
            }),
        ]);
    });

    test("detects destructive TRUNCATE, RENAME COLUMN, and RENAME TABLE as HIGH risk", () => {
        expect(analyzeMigrationSql("TRUNCATE TABLE audit_events;")).toEqual([
            expect.objectContaining({ level: "HIGH", type: "destructive_truncate" }),
        ]);
        expect(analyzeMigrationSql("ALTER TABLE users RENAME COLUMN email TO primary_email;")).toEqual([
            expect.objectContaining({ level: "HIGH", type: "destructive_rename_column" }),
        ]);
        expect(analyzeMigrationSql("ALTER TABLE old_orders RENAME TO orders;")).toEqual([
            expect.objectContaining({ level: "HIGH", type: "destructive_rename_table" }),
        ]);
    });

    test("detects altering column type as MEDIUM locking risk", () => {
        const sql = `ALTER TABLE users ALTER COLUMN age TYPE bigint;`;
        const risks = analyzeMigrationSql(sql);
        expect(risks).toEqual([
            expect.objectContaining({
                level: "MEDIUM",
                type: "locking_alter_type",
            }),
        ]);
    });

    test("detects SET NOT NULL and constraints without NOT VALID as MEDIUM risk", () => {
        expect(analyzeMigrationSql("ALTER TABLE users ALTER COLUMN email SET NOT NULL;")).toEqual([
            expect.objectContaining({ level: "MEDIUM", type: "locking_alter_column_set_not_null" }),
        ]);
        expect(analyzeMigrationSql("ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id);")).toEqual([
            expect.objectContaining({ level: "MEDIUM", type: "locking_foreign_key_without_not_valid" }),
        ]);
        expect(analyzeMigrationSql("ALTER TABLE orders ADD CONSTRAINT chk_price CHECK (price > 0);")).toEqual([
            expect.objectContaining({ level: "MEDIUM", type: "locking_check_constraint_without_not_valid" }),
        ]);
    });

    test("does not treat UNIQUE USING INDEX as a new locking index build", () => {
        expect(analyzeMigrationSql(
            "ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE USING INDEX users_email_idx;",
        )).toHaveLength(0);
    });

    test("does not classify DROP CONSTRAINT or DROP NOT NULL as DROP COLUMN", () => {
        expect(analyzeMigrationSql("ALTER TABLE users DROP CONSTRAINT users_email_key;")).toEqual([
            expect.objectContaining({ type: "destructive_drop_constraint" }),
        ]);
        expect(analyzeMigrationSql("ALTER TABLE users ALTER COLUMN email DROP NOT NULL;")).toHaveLength(0);
    });

    test("does not classify safe constraints or identifiers as procedural SQL", () => {
        expect(analyzeMigrationSql(
            "ALTER TABLE users ADD CONSTRAINT users_email_nn CHECK (email IS NOT NULL) NOT VALID;",
        )).toHaveLength(0);
        expect(analyzeMigrationSql("CREATE TABLE task_state (do text);")).toHaveLength(0);
        expect(analyzeMigrationSql("COMMENT ON COLUMN task_state.do IS 'action';")).toHaveLength(0);
    });

    test("detects VACUUM FULL and CLUSTER as HIGH locking risk", () => {
        expect(analyzeMigrationSql("VACUUM FULL public.users;")).toEqual([
            expect.objectContaining({ level: "HIGH", type: "locking_vacuum_full" }),
        ]);
        expect(analyzeMigrationSql("CLUSTER public.users USING idx_users_pkey;")).toEqual([
            expect.objectContaining({ level: "HIGH", type: "locking_cluster" }),
        ]);
        expect(analyzeMigrationSql("ALTER TABLE public.users CLUSTER ON idx_users_pkey;")).toHaveLength(0);
    });

    test("ignores comments and string literals to prevent false positives", () => {
        const sql = `
            -- DROP TABLE users;
            /*
               ALTER TABLE users DROP COLUMN email;
               CREATE INDEX idx_fake ON fake (id);
            */
            SELECT 'DROP TABLE users' AS note;
            SELECT $$ALTER TABLE users DROP COLUMN phone$$ AS log_note;
        `;
        const risks = analyzeMigrationSql(sql);
        expect(risks).toHaveLength(0);
    });

    test("ignores E-strings and quoted identifiers containing risk keywords", () => {
        const sql = `
            SELECT E'DROP TABLE users\\nCREATE INDEX idx_fake ON users(id)' AS note;
            CREATE TABLE public."DROP TABLE users" ("CREATE INDEX idx" integer);
        `;
        expect(analyzeMigrationSql(sql)).toHaveLength(0);
    });

    test("accepts benign DO blocks and rescans their bodies for privileged operations", () => {
        expect(analyzeMigrationSql(`DO $$ BEGIN EXECUTE 'DROP TABLE users'; END $$;`))
            .toHaveLength(0);
        expect(analyzeMigrationSql(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mood') THEN
                    CREATE TYPE public.mood AS ENUM ('happy', 'sad');
                END IF;
            END
            $$;
        `)).toHaveLength(0);
        expect(analyzeMigrationSql(`DO $$ BEGIN PERFORM pg_read_file('/etc/passwd'); END $$;`))
            .toEqual([
                expect.objectContaining({
                    level: "HIGH",
                    type: "unsupported_server_access",
                    blocksTransactionalPush: true,
                }),
            ]);
        expect(analyzeMigrationSql(`DO $$ BEGIN PERFORM dblink('host=remote', 'SELECT 1'); END $$;`))
            .toEqual([
                expect.objectContaining({
                    level: "HIGH",
                    type: "unsupported_external_database_access",
                    blocksTransactionalPush: true,
                }),
            ]);
        expect(analyzeMigrationSql(
            `DO $$ BEGIN INSERT INTO supabase_migrations.schema_migrations(version) VALUES ('1'); END $$;`,
        )).toEqual(expect.arrayContaining([
            expect.objectContaining({
                level: "HIGH",
                type: "unsupported_migration_ledger_access",
                blocksTransactionalPush: true,
            }),
        ]));
    });

    test("accepts a benign DO block inside the allowed outer transaction wrapper", () => {
        expect(analyzeMigrationSql(`
            BEGIN;
            DO $migration$ BEGIN PERFORM 1; END $migration$;
            COMMIT;
        `)).toHaveLength(0);
        expect(analyzeMigrationSql(`
            BEGIN;
            DO $migration$ BEGIN PERFORM pg_advisory_lock(1); END $migration$;
            COMMIT;
        `)).toEqual([
            expect.objectContaining({
                level: "HIGH",
                type: "unsupported_advisory_lock_control",
                blocksTransactionalPush: true,
            }),
        ]);
    });

    test("requires manual review for procedural definitions and calls", () => {
        expect(analyzeMigrationSql(
            "CREATE FUNCTION public.answer() RETURNS integer LANGUAGE sql AS $$ SELECT 42 $$;",
        )).toEqual([
            expect.objectContaining({ type: "manual_review_procedural_definition", level: "HIGH" }),
        ]);
        expect(analyzeMigrationSql("CALL public.rebuild_reporting();")).toEqual([
            expect.objectContaining({ type: "manual_review_procedure_call", level: "HIGH" }),
        ]);
    });

    test("blocks project-scope and server-access operations before push", () => {
        for (const sql of [
            "ALTER ROLE postgres SUPERUSER;",
            "DROP SCHEMA public CASCADE;",
            "DROP SCHEMA application_private, public CASCADE;",
            "ALTER SCHEMA public RENAME TO application_public;",
            "COPY public.accounts TO PROGRAM 'cat';",
            "COPY public.accounts TO '/var/lib/postgresql/accounts.csv';",
            "SELECT pg_read_file('/etc/passwd');",
            "CREATE SERVER remote_db FOREIGN DATA WRAPPER postgres_fdw;",
            "SELECT dblink('host=remote', 'SELECT 1');",
        ]) {
            expect(analyzeMigrationSql(sql)).toEqual(expect.arrayContaining([
                expect.objectContaining({ level: "HIGH", blocksTransactionalPush: true }),
            ]));
        }
    });

    test("allows one outer transaction wrapper but blocks nested transaction control", () => {
        expect(analyzeMigrationSql("BEGIN; CREATE TABLE wrapped(id bigint); COMMIT;"))
            .toHaveLength(0);
        expect(analyzeMigrationSql("CREATE TABLE partial(id bigint); COMMIT;"))
            .toEqual(expect.arrayContaining([
                expect.objectContaining({
                    type: "unsupported_transaction_control",
                    blocksTransactionalPush: true,
                }),
            ]));
        expect(analyzeMigrationSql("CREATE TABLE partial(id bigint); ABORT AND CHAIN; SELECT 1;"))
            .toEqual(expect.arrayContaining([
                expect.objectContaining({
                    type: "unsupported_transaction_control",
                    blocksTransactionalPush: true,
                }),
            ]));
    });

    test("blocks empty migrations after removing an outer transaction wrapper", () => {
        expect(analyzeMigrationSql("BEGIN; COMMIT;"))
            .toEqual([expect.objectContaining({
                type: "unsupported_empty_migration",
                blocksTransactionalPush: true,
            })]);
    });

    test.each([
        "SELECT 'unterminated",
        'CREATE TABLE "unterminated (id bigint)',
        "SELECT $body$unterminated",
        "SELECT 1 /* unterminated",
    ])("rejects malformed SQL before risk classification: %s", (sql) => {
        expect(() => analyzeMigrationSql(sql)).toThrow("Unterminated SQL");
    });

    test("blocks session, advisory lock, and migration ledger control", () => {
        for (const sql of [
            "SET ROLE postgres;",
            "SELECT pg_advisory_lock(42);",
            "SELECT pg_catalog.\"pg_advisory_lock\"(42);",
            "SELECT pg_catalog.\"pg_read_file\"('/etc/passwd');",
            "SELECT extensions.\"dblink\"('host=remote', 'SELECT 1');",
            "INSERT INTO supabase_migrations.schema_migrations(version) VALUES ('1');",
            "DELETE FROM \"public\".\"schema_migrations\" WHERE version = '1';",
            "DROP TABLE IF EXISTS \"supabase_migrations\".\"schema_migrations\";",
            "DROP TABLE public.disposable, public.schema_migrations CASCADE;",
            "TRUNCATE TABLE public.disposable, ONLY public.schema_migrations;",
            "LOCK TABLE public.disposable, public.schema_migrations IN ACCESS EXCLUSIVE MODE;",
            "ALTER TABLE IF EXISTS public.schema_migrations ADD COLUMN tampered boolean;",
            "CREATE INDEX ledger_version_idx ON public.schema_migrations(version);",
            "CREATE TRIGGER ledger_guard BEFORE INSERT ON public.schema_migrations FOR EACH ROW EXECUTE FUNCTION public.audit();",
            "DROP TRIGGER IF EXISTS ledger_guard ON public.schema_migrations;",
            "CREATE RULE ledger_rule AS ON INSERT TO public.schema_migrations DO INSTEAD NOTHING;",
            "DROP RULE IF EXISTS ledger_rule ON public.schema_migrations;",
            "CREATE POLICY ledger_policy ON public.schema_migrations USING (true);",
            "COMMENT ON TABLE public.schema_migrations IS 'tampered';",
            "SECURITY LABEL ON TABLE public.schema_migrations IS 'tampered';",
            "REINDEX TABLE public.schema_migrations;",
            "REINDEX (VERBOSE) TABLE CONCURRENTLY public.schema_migrations;",
            "CLUSTER VERBOSE public.schema_migrations;",
            "VACUUM (ANALYZE) public.schema_migrations;",
            "ANALYZE public.schema_migrations;",
            "GRANT SELECT ON public.accounts, public.schema_migrations TO authenticated;",
            "GRANT SELECT ON ALL TABLES IN SCHEMA supabase_migrations TO authenticated;",
            "GRANT SELECT ON supabase_migrations.schema_migrations TO authenticated;",
            "SELECT \"supabase_migrations\".\"record_schema_migration\"('1', ARRAY['SELECT 1'], 'fake', 'checksum');",
        ]) {
            expect(analyzeMigrationSql(sql)).toEqual(expect.arrayContaining([
                expect.objectContaining({ level: "HIGH", blocksTransactionalPush: true }),
            ]));
        }
        expect(analyzeMigrationSql("GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;"))
            .toHaveLength(0);
        expect(analyzeMigrationSql("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;"))
            .toHaveLength(0);
        expect(analyzeMigrationSql("GRANT SELECT ON public.accounts TO schema_migrations;"))
            .toHaveLength(0);
        expect(analyzeMigrationSql("GRANT EXECUTE ON FUNCTION public.audit(schema_migrations) TO authenticated;"))
            .toHaveLength(0);
        expect(analyzeMigrationSql("GRANT USAGE ON SCHEMA schema_migrations TO authenticated;"))
            .toHaveLength(0);
        expect(analyzeMigrationSql("GRANT EXECUTE ON FUNCTION public.schema_migrations(text) TO authenticated;"))
            .toHaveLength(0);
        expect(analyzeMigrationSql("CREATE INDEX account_email_idx ON public.accounts(email);"))
            .not.toContainEqual(expect.objectContaining({ type: "unsupported_migration_ledger_access" }));
        expect(analyzeMigrationSql("COMMENT ON TABLE public.accounts IS 'application data';"))
            .not.toContainEqual(expect.objectContaining({ type: "unsupported_migration_ledger_access" }));
    });

    test("blocks quoted public schema removal before push", () => {
        expect(analyzeMigrationSql('DROP SCHEMA "public" CASCADE;')).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "unsupported_public_schema_removal",
                blocksTransactionalPush: true,
            }),
        ]));
    });

    test("blocks Unicode-escaped identifiers that could hide protected names", () => {
        expect(analyzeMigrationSql(String.raw`DROP SCHEMA U&"p\0075blic" CASCADE;`))
            .toEqual(expect.arrayContaining([
                expect.objectContaining({
                    type: "unsupported_unicode_escaped_identifier",
                    blocksTransactionalPush: true,
                }),
            ]));
    });

    test("formats multi-file risk report with clear guidance", () => {
        const files = [
            {
                file: "20260819_01_safe.sql",
                sql: "CREATE TABLE t (id int);",
            },
            {
                file: "20260819_02_index.sql",
                sql: "CREATE INDEX idx_t ON t (id);",
            },
            {
                file: "20260819_03_drop.sql",
                sql: "DROP TABLE old_t;",
            },
        ];
        const analysis = analyzeMigrationFiles(files);
        expect(analysis.overallRisk).toBe("HIGH");
        expect(analysis.highRiskCount).toBe(1);
        expect(analysis.mediumRiskCount).toBe(1);

        const report = formatMigrationRiskReport(analysis);
        expect(report).toContain("🔴 Migration Risk Level: HIGH");
        expect(report).toContain("20260819_02_index.sql");
        expect(report).toContain("20260819_03_drop.sql");
        expect(report).toContain("CREATE INDEX CONCURRENTLY");
    });
});
