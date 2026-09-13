import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startGraphqlPostgres } from "../helpers/graphql-postgres";

// Run alone: the real DB module is initialized against this disposable local database.
describe.skipIf(process.env["SUPACLOUD_TEST_GRAPHQL_LOCAL"] !== "1")("pg_graphql project enablement", () => {
    let runtime: Awaited<ReturnType<typeof startGraphqlPostgres>> | undefined;
    let service: typeof import("../../src/services/extension.service") | undefined;
    let database: typeof import("../../src/db") | undefined;
    function context() {
        if (!runtime || !service) throw new Error("Local fixture not initialized");
        return { runtime, extensionService: service.extensionService };
    }
    beforeAll(async () => {
        runtime = await startGraphqlPostgres();
        database = await import("../../src/db");
        service = await import("../../src/services/extension.service");
    }, 60_000);
    afterAll(async () => {
        try { await database?.closeDb(); } finally { await runtime?.cleanup(); }
    }, 60_000);

    test("enables a real HTTP RPC from a fallback without bypassing caller RLS", async () => {
        const { runtime, extensionService } = context();
        const project = await runtime.project("first");
        const sibling = await runtime.project("sibling");
        const request = await runtime.http(project.dbName);
        const body = { query: "query Items { itemsCollection { edges { node { id owner } } } }", operationName: "Items" };
        expect(JSON.stringify((await request(body)).payload)).toContain("GraphQL is not available");
        const result = await extensionService.enableExtension(project.ref, "pg_graphql");
        expect(result.is_installed).toBe(true);
        let response = await request(body);
        for (let attempt = 0; attempt < 30 && JSON.stringify(response.payload).includes("GraphQL is not available"); attempt++) {
            await Bun.sleep(100);
            response = await request(body);
        }
        expect(response).toEqual({
            status: 200, payload: { data: { itemsCollection: { edges: [{ node: { id: 1, owner: "alice" } }] } } },
        });
        expect(await request(body, "authenticated", "bob")).toEqual({
            status: 200, payload: { data: { itemsCollection: { edges: [{ node: { id: 2, owner: "bob" } }] } } },
        });
        expect((await request(body, "service_role")).payload).toEqual({
            data: { itemsCollection: { edges: [{ node: { id: 1, owner: "alice" } }, { node: { id: 2, owner: "bob" } }] } },
        });
        expect(JSON.stringify((await request(body, "anon")).payload)).toContain("errors");
        expect(JSON.stringify((await request({ query: "{ private_itemsCollection { edges { node { id } } } }" })).payload)).toContain("errors");
        expect((await request(body, "authenticated", "alice", "graphql")).status).toBe(406);
        expect(Array.from(await project.db`
            SELECT p.prosecdef AS definer, p.provolatile AS volatility,
                has_function_privilege('outsider', p.oid, 'EXECUTE') AS outsider
            FROM pg_proc p WHERE p.oid = 'graphql_public.graphql(text,text,jsonb,jsonb)'::regprocedure
        `)).toEqual([{ definer: false, volatility: "v", outsider: false }]);
        expect(await sibling.db`SELECT extname FROM pg_extension WHERE extname = 'pg_graphql'`).toHaveLength(0);
        expect(Array.from(await sibling.db`SELECT graphql_public.graphql() AS result`)).toEqual([
            { result: { errors: [{ message: "GraphQL is not available on this project." }] } },
        ]);
    }, 60_000);

    test("repairs already-installed projects and preserves restricted ACLs and four-argument dependencies", async () => {
        const { runtime, extensionService } = context();
        const project = await runtime.project("repair", "none");
        await project.db.unsafe("CREATE EXTENSION pg_graphql");
        await extensionService.enableExtension(project.ref, "pg_graphql");
        await project.db.unsafe(`
            REVOKE ALL ON FUNCTION graphql_public.graphql(text,text,jsonb,jsonb) FROM anon, authenticated;
            CREATE VIEW public.graphql_dependency AS SELECT graphql_public.graphql(query => '{ __typename }') AS result;
        `);
        const before: unknown = await project.db`
            SELECT oid::text, proacl::text FROM pg_proc
            WHERE oid = 'graphql_public.graphql(text,text,jsonb,jsonb)'::regprocedure
        `;
        await extensionService.enableExtension(project.ref, "pg_graphql");
        await extensionService.enableExtension(project.ref, "pg_graphql");
        const after: unknown = await project.db`
            SELECT oid::text, proacl::text FROM pg_proc
            WHERE oid = 'graphql_public.graphql(text,text,jsonb,jsonb)'::regprocedure
        `;
        expect(after).toEqual(before);
        const request = await runtime.http(project.dbName);
        expect((await request({ query: "{ __typename }" }, "service_role")).payload).toEqual({ data: { __typename: "Query" } });
        expect((await request({ query: "{ __typename }" }, "authenticated")).status).toBeGreaterThanOrEqual(400);
        expect((await request({ query: "{ __typename }" }, "anon")).status).toBeGreaterThanOrEqual(400);
        expect(Array.from(await project.db`SELECT * FROM public.graphql_dependency`)).toEqual([{ result: { data: { __typename: "Query" } } }]);
    }, 60_000);

    test("migrates a restricted three-argument stub without ambiguous overloads or wider grants", async () => {
        const { runtime, extensionService } = context();
        const project = await runtime.project("legacy", "three");
        await project.db.unsafe(`
            REVOKE ALL ON FUNCTION graphql_public.graphql(text,text,jsonb) FROM PUBLIC, anon, authenticated;
            GRANT EXECUTE ON FUNCTION graphql_public.graphql(text,text,jsonb) TO service_role WITH GRANT OPTION;
            ALTER DEFAULT PRIVILEGES IN SCHEMA graphql_public GRANT EXECUTE ON FUNCTIONS TO outsider, authenticated;
        `);
        await extensionService.enableExtension(project.ref, "pg_graphql");
        expect(Array.from(await project.db`
            SELECT to_regprocedure('graphql_public.graphql(text,text,jsonb)')::text AS legacy,
                has_function_privilege('anon', 'graphql_public.graphql(text,text,jsonb,jsonb)', 'EXECUTE') AS anon,
                has_function_privilege('authenticated', 'graphql_public.graphql(text,text,jsonb,jsonb)', 'EXECUTE') AS authenticated,
                has_function_privilege('outsider', 'graphql_public.graphql(text,text,jsonb,jsonb)', 'EXECUTE') AS outsider,
                has_function_privilege('service_role', 'graphql_public.graphql(text,text,jsonb,jsonb)', 'EXECUTE WITH GRANT OPTION') AS service
        `)).toEqual([{ legacy: null, anon: false, authenticated: false, outsider: false, service: true }]);
        const request = await runtime.http(project.dbName);
        expect(await request({ query: "query Named { __typename }", operationName: "Named", variables: {}, extensions: {} }, "service_role")).toEqual({
            status: 200, payload: { data: { __typename: "Query" } },
        });
    }, 60_000);

    test("repairs an installed fallback with both overloads without widening the current ACL", async () => {
        const { runtime, extensionService } = context();
        const project = await runtime.project("overloads");
        await project.db.unsafe(`
            CREATE EXTENSION pg_graphql;
            CREATE FUNCTION graphql_public.graphql(
                "operationName" text DEFAULT NULL, query text DEFAULT NULL, variables jsonb DEFAULT NULL
            ) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
            GRANT EXECUTE ON FUNCTION graphql_public.graphql(text,text,jsonb) TO anon, authenticated;
            REVOKE ALL ON FUNCTION graphql_public.graphql(text,text,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
        `);
        await extensionService.enableExtension(project.ref, "pg_graphql");
        const request = await runtime.http(project.dbName);
        expect(await request({ query: "{ __typename }" }, "service_role")).toEqual({
            status: 200, payload: { data: { __typename: "Query" } },
        });
        expect((await request({ query: "{ __typename }" }, "authenticated")).status).toBeGreaterThanOrEqual(400);
        expect(Array.from(await project.db`
            SELECT to_regprocedure('graphql_public.graphql(text,text,jsonb)')::text AS legacy
        `)).toEqual([{ legacy: null }]);
    }, 60_000);

    test("rolls back extension and fallback replacement when entrypoint grants fail", async () => {
        const { runtime, extensionService } = context();
        const project = await runtime.project("rollback");
        await project.db.unsafe(`
            CREATE FUNCTION public.reject_graphql_grant() RETURNS event_trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure('graphql_public.graphql(text,text,jsonb,jsonb)') AND provolatile = 'v') THEN
                    RAISE EXCEPTION 'injected GraphQL grant failure';
                END IF;
            END;
            $$;
            CREATE EVENT TRIGGER reject_graphql_grant ON ddl_command_end WHEN TAG IN ('GRANT')
                EXECUTE FUNCTION public.reject_graphql_grant();
        `);
        await expect(extensionService.enableExtension(project.ref, "pg_graphql")).rejects.toThrow("injected GraphQL grant failure");
        expect(await project.db`SELECT extname FROM pg_extension WHERE extname = 'pg_graphql'`).toHaveLength(0);
        expect(Array.from(await project.db`SELECT graphql_public.graphql() AS result`)).toEqual([
            { result: { errors: [{ message: "GraphQL is not available on this project." }] } },
        ]);
    }, 60_000);

    test("leaves the legacy stub and its dependencies intact when repair is unsafe", async () => {
        const { runtime, extensionService } = context();
        const project = await runtime.project("dependent", "three");
        await project.db.unsafe("CREATE VIEW public.stub_dependency AS SELECT graphql_public.graphql() AS result");
        await expect(extensionService.enableExtension(project.ref, "pg_graphql")).rejects.toThrow("depend");
        expect(await project.db`SELECT extname FROM pg_extension WHERE extname = 'pg_graphql'`).toHaveLength(0);
        expect(Array.from(await project.db`SELECT * FROM public.stub_dependency`)).toEqual([
            { result: { errors: [{ message: "GraphQL is not available on this project." }] } },
        ]);
        await expect(extensionService.enableExtension(project.ref, "pg_graphql", undefined, "not_a_real_version")).rejects.toThrow();
        expect(await project.db`SELECT extname FROM pg_extension WHERE extname = 'pg_graphql'`).toHaveLength(0);
    }, 60_000);
});
