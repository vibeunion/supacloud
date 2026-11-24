// @supacloud-test-isolate
// Local only. Set SUPACLOUD_TEST_POSTRUST_GRAPHQL=1, POSTRUST_BIN, and have
// PostgreSQL 16's initdb on POSTGRES_BIN or /usr/lib/postgresql/16/bin.
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
const query = "{ claim_sub_notes { id owner } claims_notes { id owner } }";

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

live("anon and authenticated queries through the evaluation route follow the two claim settings", async () => {
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

    process.env[POSTRUST_GRAPHQL_EVALUATION_ENV] = "true";
    spies.push(spyOn(sdkProxyInternals, "resolveProjectRefFromApiKey").mockResolvedValue("evalref"));
    spies.push(spyOn(sdkProxyInternals, "resolveProjectApiKey").mockImplementation(async (candidate: string) => (
        candidate === "service-key"
            ? { ref: "evalref", role: "service_role", kind: "service_role", upstreamKey: token("service_role", "operator") }
            : null
    )));
    spies.push(spyOn(sdkProxyInternals, "resolveProjectServiceRoleKey").mockResolvedValue(token("service_role", "operator")));
    setSdkProxySqlForTests(async () => [{ config: { postgrest_port: restPort, gotrue_port: restPort + 1 } }]);
    const app = new Elysia().use(sdkProxyRoutes);

    async function through(role: string, sub: string) {
        const response = await app.handle(new Request("http://127.0.0.1/internal/postrust/graphql", {
            method: "POST",
            headers: {
                apikey: "service-key",
                authorization: `Bearer ${token(role, sub)}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({ query }),
        }));
        const payload: unknown = await response.json();
        return { status: response.status, payload };
    }

    const anon = await through("anon", "alice");
    const alice = await through("authenticated", "alice");
    const bob = await through("authenticated", "bob");
    expect(anon.status).toBe(200);
    expect(alice.status).toBe(200);
    expect(bob.status).toBe(200);
    expect(anon.payload).not.toHaveProperty("errors");
    expect(alice.payload).not.toHaveProperty("errors");
    expect(ids(anon.payload, "claim_sub_notes"), JSON.stringify(anon.payload)).toEqual([]);
    expect(ids(anon.payload, "claims_notes"), JSON.stringify(anon.payload)).toEqual([]);
    expect(ids(alice.payload, "claim_sub_notes"), JSON.stringify(alice.payload)).toEqual([]);
    expect(ids(alice.payload, "claims_notes"), JSON.stringify(alice.payload)).toEqual([1]);
    expect(ids(bob.payload, "claim_sub_notes"), JSON.stringify(bob.payload)).toEqual([]);
    expect(ids(bob.payload, "claims_notes"), JSON.stringify(bob.payload)).toEqual([2]);
}, 60_000);
