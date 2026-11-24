// @supacloud-test-isolate
// CI sets SUPACLOUD_TEST_POSTRUST_GRAPHQL=1 and POSTRUST_BIN to the pinned
// Postrust v3.4.0 binary. PostgreSQL 16's initdb is POSTGRES_BIN or
// /usr/lib/postgresql/16/bin. Without those, this file skips.
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { POSTRUST_GRAPHQL_EVALUATION_ENV } from "../../src/services/postrust-graphql-evaluation";
import { sdkProxyInternals, sdkProxyRoutes, setSdkProxySqlForTests } from "../../src/routes/sdk-proxy";

const enabled = process.env.SUPACLOUD_TEST_POSTRUST_GRAPHQL === "1";
const postrustBin = process.env.POSTRUST_BIN ?? "";
const postgresBin = process.env.POSTGRES_BIN ?? "/usr/lib/postgresql/16/bin";
const live = enabled && postrustBin.length > 0 ? test : test.skip;

const secret = randomBytes(32).toString("hex");
const password = randomBytes(18).toString("hex");
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const PUBLISHABLE = "sb_publishable_fixture";
const claimQuery = "{ claim_sub_notes { id owner } claims_notes { id owner } }";
const introspectionQuery = `{
  __schema {
    queryType { name }
    types {
      name
      fields {
        name
        type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
      }
    }
  }
}`;

function token(role: string, sub: string): string {
    const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({
        role,
        sub,
        exp: Math.floor(Date.now() / 1000) + 600,
    })).toString("base64url");
    const signature = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
    return `${head}.${body}.${signature}`;
}

async function run(bin: string, args: string[], env: Record<string, string> = {}): Promise<string> {
    const child = Bun.spawn([bin, ...args], {
        env: { ...process.env, ...env },
        stdout: "pipe",
        stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(err || out);
    return out;
}

type IntroType = { kind?: string; name?: string | null; ofType?: IntroType | null };
type IntroField = { name: string; typeName: string | null };

function unwrapTypeName(type: IntroType | null | undefined): string | null {
    let current = type ?? null;
    while (current?.ofType) current = current.ofType;
    return typeof current?.name === "string" ? current.name : null;
}

function schemaCatalog(payload: unknown): { queryType: string; types: Map<string, IntroField[]> } {
    if (!payload || typeof payload !== "object" || !("data" in payload)) {
        throw new Error(`missing introspection data: ${JSON.stringify(payload)}`);
    }
    const data = (payload as { data?: { __schema?: { queryType?: { name?: string }; types?: unknown[] } } }).data;
    const queryType = data?.__schema?.queryType?.name;
    if (!queryType) throw new Error(`missing query type: ${JSON.stringify(payload)}`);
    const types = new Map<string, IntroField[]>();
    for (const type of data?.__schema?.types ?? []) {
        if (!type || typeof type !== "object" || !("name" in type) || typeof type.name !== "string") continue;
        const fields = "fields" in type && Array.isArray(type.fields) ? type.fields : [];
        types.set(type.name, fields.flatMap((field) => {
            if (!field || typeof field !== "object" || !("name" in field) || typeof field.name !== "string") return [];
            const typeName = "type" in field ? unwrapTypeName(field.type as IntroType) : null;
            return [{ name: field.name, typeName }];
        }));
    }
    return { queryType, types };
}

function nestedIds(payload: unknown, authorsField: string, notesField: string, authorId: string): number[] {
    if (!payload || typeof payload !== "object" || !("data" in payload)) return [];
    const data = (payload as { data?: Record<string, unknown> }).data;
    const authors = data?.[authorsField];
    if (!Array.isArray(authors)) return [];
    const author = authors.find((row) => row && typeof row === "object" && (row as { id?: unknown }).id === authorId);
    if (!author || typeof author !== "object") return [];
    const notes = (author as Record<string, unknown>)[notesField];
    if (!Array.isArray(notes)) return [];
    return notes.flatMap((row) => {
        if (!row || typeof row !== "object" || !("id" in row)) return [];
        const id = (row as { id?: unknown }).id;
        return typeof id === "number" ? [id] : [];
    });
}

function ids(payload: unknown, field: string): number[] {
    if (!payload || typeof payload !== "object" || !("data" in payload)) return [];
    const data = (payload as { data?: Record<string, unknown> }).data;
    const rows = data?.[field];
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((row) => {
        if (!row || typeof row !== "object" || !("id" in row)) return [];
        const id = (row as { id?: unknown }).id;
        return typeof id === "number" ? [id] : [];
    });
}

let dataDir = "";
let postrust: ReturnType<typeof Bun.spawn> | undefined;
const spies: Array<{ mockRestore(): void }> = [];

afterAll(async () => {
    delete process.env[POSTRUST_GRAPHQL_EVALUATION_ENV];
    setSdkProxySqlForTests();
    for (const spy of spies.splice(0)) spy.mockRestore();
    postrust?.kill();
    if (postrust) await postrust.exited;
    if (dataDir) {
        await run(join(postgresBin, "pg_ctl"), ["-D", dataDir, "-m", "immediate", "stop"]).catch(() => undefined);
        await rm(dataDir, { recursive: true, force: true });
    }
});

live("public /graphql/v1 applies claim, auth.uid, and nested RLS for anon and authenticated", async () => {
    delete process.env[POSTRUST_GRAPHQL_EVALUATION_ENV];
    dataDir = await mkdtemp(join(tmpdir(), "postrust-graphql-rls-"));
    await run(join(postgresBin, "initdb"), ["-D", dataDir, "--username=postgres", "--auth=trust", "--no-sync"]);
    const port = 46000 + Math.floor(Math.random() * 1000);
    await run(join(postgresBin, "pg_ctl"), [
        "-D", dataDir, "-l", join(dataDir, "server.log"), "-w", "start",
        "-o", `-k ${dataDir} -p ${port} -c listen_addresses=127.0.0.1`,
    ]);
    const psql = join(postgresBin, "psql");
    const sql = async (statement: string) => run(psql, [
        "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres",
        "-v", "ON_ERROR_STOP=1", "-c", statement,
    ]);
    await sql(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN BYPASSRLS;
        CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD '${password}';
        GRANT anon, authenticated, service_role TO authenticator;
        CREATE FUNCTION public.set_request_context() RETURNS void AS $$
        DECLARE claims jsonb;
        BEGIN
          BEGIN
            claims := COALESCE(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
          EXCEPTION WHEN invalid_text_representation THEN
            claims := '{}'::jsonb;
          END;
          PERFORM set_config('request.jwt.claim.sub', coalesce(claims ->> 'sub', ''), true);
          PERFORM set_config('request.jwt.claim.role', coalesce(claims ->> 'role', ''), true);
        END $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog;
        GRANT EXECUTE ON FUNCTION public.set_request_context() TO anon, authenticated, service_role;
        CREATE TABLE public.claim_sub_notes (id int PRIMARY KEY, owner text NOT NULL);
        CREATE TABLE public.claims_notes (id int PRIMARY KEY, owner text NOT NULL);
        INSERT INTO public.claim_sub_notes VALUES (1, 'alice'), (2, 'bob');
        INSERT INTO public.claims_notes VALUES (1, 'alice'), (2, 'bob');
        ALTER TABLE public.claim_sub_notes ENABLE ROW LEVEL SECURITY;
        ALTER TABLE public.claims_notes ENABLE ROW LEVEL SECURITY;
        GRANT SELECT ON public.claim_sub_notes, public.claims_notes TO anon, authenticated;
        CREATE POLICY claim_sub_read ON public.claim_sub_notes FOR SELECT TO authenticated
          USING (owner = coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), ''));
        CREATE POLICY claims_read ON public.claims_notes FOR SELECT TO authenticated
          USING (owner = coalesce((nullif(current_setting('request.jwt.claims', true), ''))::jsonb ->> 'sub', ''));
        CREATE SCHEMA IF NOT EXISTS auth;
        GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
        CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$
        BEGIN
          RETURN COALESCE(
            nullif(current_setting('request.jwt.claim.sub', true), ''),
            (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
          )::uuid;
        EXCEPTION WHEN invalid_text_representation THEN
          RETURN NULL;
        END $$ LANGUAGE plpgsql STABLE;
        GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
        CREATE TABLE public.authors (id uuid PRIMARY KEY, name text NOT NULL);
        CREATE TABLE public.uid_notes (
          id int PRIMARY KEY,
          author_id uuid NOT NULL REFERENCES public.authors(id),
          body text NOT NULL
        );
        INSERT INTO public.authors VALUES ('${ALICE}', 'alice'), ('${BOB}', 'bob');
        INSERT INTO public.uid_notes VALUES (1, '${ALICE}', 'alice'), (2, '${BOB}', 'bob');
        ALTER TABLE public.uid_notes ENABLE ROW LEVEL SECURITY;
        GRANT SELECT ON public.authors, public.uid_notes TO anon, authenticated;
        CREATE POLICY uid_read ON public.uid_notes FOR SELECT TO authenticated
          USING (author_id = auth.uid());
    `);
    const restPort = port + 1;
    postrust = Bun.spawn([postrustBin], {
        env: {
            ...process.env,
            PGRST_DB_URI: `postgres://authenticator:${password}@127.0.0.1:${port}/postgres`,
            PGRST_JWT_SECRET: secret,
            PGRST_DB_ANON_ROLE: "anon",
            PGRST_DB_SCHEMAS: "public",
            PGRST_COMPAT_MODE: "true",
            PGRST_SERVER_HOST: "127.0.0.1",
            PGRST_SERVER_PORT: String(restPort),
            PGRST_DB_PRE_REQUEST: "public.set_request_context",
        },
        stdout: "pipe",
        stderr: "pipe",
    });
    const ready = `http://127.0.0.1:${restPort}/`;
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
            if ((await fetch(ready)).ok) break;
        } catch { /* process still binding */ }
        await Bun.sleep(100);
        if (attempt === 49) throw new Error("Postrust did not become ready");
    }

    spies.push(spyOn(sdkProxyInternals, "resolveProjectRefFromApiKey").mockImplementation(async (candidate: string) => (
        candidate === PUBLISHABLE ? "evalref" : ""
    )));
    spies.push(spyOn(sdkProxyInternals, "resolveProjectApiKey").mockImplementation(async (candidate: string) => (
        candidate === PUBLISHABLE
            ? { ref: "evalref", role: "anon", kind: "publishable", upstreamKey: token("anon", "00000000-0000-0000-0000-000000000000") }
            : null
    )));
    setSdkProxySqlForTests(async () => [{ config: { postgrest_port: restPort, gotrue_port: restPort + 1 } }]);
    const app = new Elysia().use(sdkProxyRoutes);

    async function through(role: string, sub: string, document: string) {
        const response = await app.handle(new Request("http://127.0.0.1/graphql/v1", {
            method: "POST",
            headers: {
                apikey: PUBLISHABLE,
                authorization: `Bearer ${token(role, sub)}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({ query: document }),
        }));
        const payload: unknown = await response.json();
        return { status: response.status, payload };
    }

    const intro = await through("authenticated", ALICE, introspectionQuery);
    expect(intro.status, JSON.stringify(intro.payload)).toBe(200);
    expect(intro.payload).not.toHaveProperty("errors");
    const catalog = schemaCatalog(intro.payload);
    expect(catalog.queryType).toBe("query_root");
    const rootFields = catalog.types.get(catalog.queryType) ?? [];
    const uidField = rootFields.find((field) => field.typeName === "uid_notes");
    const authorsField = rootFields.find((field) => field.typeName === "authors");
    expect(uidField, JSON.stringify(rootFields)).toBeDefined();
    const authorFields = catalog.types.get("authors") ?? [];
    const nested = authorFields.find((field) => field.typeName === "uid_notes");
    expect(authorsField, JSON.stringify(rootFields)).toBeDefined();
    expect(nested, JSON.stringify(authorFields)).toBeDefined();
    const uidQuery = `{ ${uidField!.name} { id } ${authorsField!.name} { id ${nested!.name} { id } } }`;

    const anon = await through("anon", "alice", claimQuery);
    const alice = await through("authenticated", "alice", claimQuery);
    const bob = await through("authenticated", "bob", claimQuery);
    expect(anon.status).toBe(200);
    expect(alice.status).toBe(200);
    expect(bob.status).toBe(200);
    expect(anon.payload).not.toHaveProperty("errors");
    expect(alice.payload).not.toHaveProperty("errors");
    expect(bob.payload).not.toHaveProperty("errors");
    expect(ids(anon.payload, "claim_sub_notes"), JSON.stringify(anon.payload)).toEqual([]);
    expect(ids(anon.payload, "claims_notes"), JSON.stringify(anon.payload)).toEqual([]);
    expect(ids(alice.payload, "claim_sub_notes"), JSON.stringify(alice.payload)).toEqual([]);
    expect(ids(alice.payload, "claims_notes"), JSON.stringify(alice.payload)).toEqual([1]);
    expect(ids(bob.payload, "claim_sub_notes"), JSON.stringify(bob.payload)).toEqual([]);
    expect(ids(bob.payload, "claims_notes"), JSON.stringify(bob.payload)).toEqual([2]);

    const relay = await through(
        "authenticated",
        "alice",
        "{ claim_sub_notesCollection(first: 1) { edges { node { id } } } }",
    );
    expect(relay.status, JSON.stringify(relay.payload)).toBe(200);
    expect(relay.payload).toEqual({
        errors: [{
            message: "field 'claim_sub_notesCollection' not found in type: 'query_root'",
            extensions: {
                code: "validation-failed",
                path: "$.selectionSet.claim_sub_notesCollection",
            },
        }],
    });

    const anonUid = await through("anon", ALICE, uidQuery);
    const aliceUid = await through("authenticated", ALICE, uidQuery);
    const bobUid = await through("authenticated", BOB, uidQuery);
    expect(anonUid.status, JSON.stringify(anonUid.payload)).toBe(200);
    expect(aliceUid.status, JSON.stringify(aliceUid.payload)).toBe(200);
    expect(bobUid.status, JSON.stringify(bobUid.payload)).toBe(200);
    expect(anonUid.payload).not.toHaveProperty("errors");
    expect(aliceUid.payload).not.toHaveProperty("errors");
    expect(bobUid.payload).not.toHaveProperty("errors");
    expect(ids(anonUid.payload, uidField!.name), JSON.stringify(anonUid.payload)).toEqual([]);
    expect(ids(aliceUid.payload, uidField!.name), JSON.stringify(aliceUid.payload)).toEqual([1]);
    expect(ids(bobUid.payload, uidField!.name), JSON.stringify(bobUid.payload)).toEqual([2]);
    expect(nestedIds(aliceUid.payload, authorsField!.name, nested!.name, ALICE), JSON.stringify(aliceUid.payload)).toEqual([1]);
    expect(nestedIds(aliceUid.payload, authorsField!.name, nested!.name, BOB), JSON.stringify(aliceUid.payload)).toEqual([]);
    expect(nestedIds(bobUid.payload, authorsField!.name, nested!.name, BOB), JSON.stringify(bobUid.payload)).toEqual([2]);
    expect(nestedIds(bobUid.payload, authorsField!.name, nested!.name, ALICE), JSON.stringify(bobUid.payload)).toEqual([]);
}, 90_000);
