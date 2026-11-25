// @supacloud-test-isolate
// CI sets SUPACLOUD_TEST_POSTRUST_NULL_RPC=1 and POSTRUST_BIN to the patched
// Postrust v3.4.0 binary. PostgreSQL 16's initdb is POSTGRES_BIN or
// /usr/lib/postgresql/16/bin. Without those, this file skips.
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";

const postrustBin = process.env.POSTRUST_BIN ?? "";
const postgresBin = process.env.POSTGRES_BIN ?? "/usr/lib/postgresql/16/bin";
const enabled = process.env.SUPACLOUD_TEST_POSTRUST_NULL_RPC === "1" && postrustBin.length > 0;
const live = enabled ? test : test.skip;

const secret = randomBytes(32).toString("hex");
const password = randomBytes(18).toString("hex");
const actor = "11111111-1111-4111-8111-111111111111";

function token(role: string): string {
    const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({
        role,
        sub: actor,
        exp: Math.floor(Date.now() / 1000) + 600,
    })).toString("base64url");
    const signature = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
    return `${head}.${body}.${signature}`;
}

async function run(bin: string, args: string[]): Promise<string> {
    const child = Bun.spawn([bin, ...args], {
        env: process.env,
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

let dataDir = "";
let postrust: ReturnType<typeof Bun.spawn> | undefined;

afterAll(async () => {
    postrust?.kill();
    if (postrust) await postrust.exited;
    if (dataDir) {
        await run(join(postgresBin, "pg_ctl"), ["-D", dataDir, "-m", "immediate", "stop"]).catch(() => undefined);
        await rm(dataDir, { recursive: true, force: true });
    }
});

live("JSON null RPC arguments bind as SQL NULL", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "postrust-null-rpc-"));
    await run(join(postgresBin, "initdb"), ["-D", dataDir, "--username=postgres", "--auth=trust", "--no-sync"]);
    const port = 47000 + Math.floor(Math.random() * 1000);
    await run(join(postgresBin, "pg_ctl"), [
        "-D", dataDir, "-l", join(dataDir, "server.log"), "-w", "start",
        "-o", `-k ${dataDir} -p ${port} -c listen_addresses=127.0.0.1`,
    ]);
    const psql = join(postgresBin, "psql");
    await run(psql, [
        "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres",
        "-v", "ON_ERROR_STOP=1", "-c", `
            CREATE ROLE anon NOLOGIN;
            CREATE ROLE authenticated NOLOGIN;
            CREATE ROLE service_role NOLOGIN BYPASSRLS;
            CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD '${password}';
            GRANT anon, authenticated, service_role TO authenticator;
            CREATE FUNCTION public.null_rpc_probe(p_id uuid, p_at timestamptz, p_n integer)
            RETURNS boolean
            LANGUAGE sql
            STABLE
            AS $$ SELECT p_id IS NULL AND p_at IS NULL AND p_n IS NULL $$;
            GRANT EXECUTE ON FUNCTION public.null_rpc_probe(uuid, timestamptz, integer)
              TO anon, authenticated, service_role;
        `,
    ]);

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
        if (attempt === 49) throw new Error("Patched Postrust did not become ready");
    }

    async function call(body: Record<string, unknown>) {
        const response = await fetch(`http://127.0.0.1:${restPort}/rpc/null_rpc_probe`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token("service_role")}`,
                "content-type": "application/json",
                accept: "application/json",
            },
            body: JSON.stringify(body),
        });
        const text = await response.text();
        return { status: response.status, text };
    }

    const nulled = await call({ p_id: null, p_at: null, p_n: null });
    expect(nulled.status, nulled.text).toBe(200);
    expect(nulled.text).not.toContain("22P02");
    expect(nulled.text).not.toContain('invalid input syntax');
    expect(JSON.parse(nulled.text)).toBe(true);

    const present = await call({
        p_id: actor,
        p_at: "2026-11-25T00:00:00Z",
        p_n: 1,
    });
    expect(present.status, present.text).toBe(200);
    expect(JSON.parse(present.text)).toBe(false);

    const empty = await call({ p_id: "", p_at: null, p_n: null });
    expect(empty.status, empty.text).not.toBe(200);
    expect(empty.text).toContain("22P02");
}, 90_000);
