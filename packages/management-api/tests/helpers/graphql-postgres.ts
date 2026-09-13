import { SQL } from "bun";
import { createHmac, randomBytes, randomUUID } from "node:crypto";

// This harness only creates disposable local containers; it never accepts a database URL.
export async function startGraphqlPostgres() {
    const name = `sc-graphql-enable-${randomUUID().slice(0, 8)}`;
    const password = randomBytes(24).toString("hex");
    const secret = randomBytes(32).toString("hex");
    const containers: string[] = [];
    const connections: SQL[] = [];
    let networkCreated = false;
    const previousDatabaseUrl = process.env["DATABASE_URL"];
    async function command(args: string[], env: Record<string, string> = {}): Promise<string> {
        const child = Bun.spawn(["docker", ...args], {
            env: { ...process.env, POSTGRES_PASSWORD: password, ...env },
            stdout: "pipe", stderr: "pipe",
        });
        const timer = setTimeout(() => child.kill(), 60_000);
        try {
            const [code, out, err] = await Promise.all([
                child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
            ]);
            if (code !== 0) throw new Error(err.replaceAll(password, "[redacted]").replaceAll(secret, "[redacted]"));
            return out.trim();
        } finally {
            clearTimeout(timer);
            if (child.exitCode === null) { child.kill(); await child.exited; }
        }
    }
    async function waitFor(check: () => Promise<boolean>): Promise<void> {
        for (let attempt = 0; attempt < 100; attempt++) {
            try { if (await check()) return; } catch { /* Local container startup. */ }
            await Bun.sleep(100);
        }
        throw new Error("Local GraphQL runtime did not become ready");
    }
    async function cleanup(): Promise<void> {
        if (previousDatabaseUrl === undefined) delete process.env["DATABASE_URL"];
        else process.env["DATABASE_URL"] = previousDatabaseUrl;
        await Promise.all(connections.map(db => db.close({ timeout: 1 })));
        try {
            if (containers.length > 0) await command(["rm", "-f", "-v", ...containers]);
        } finally {
            if (networkCreated) await command(["network", "rm", name]);
        }
    }
    try {
        await command(["image", "inspect", "supacloud-graphql-test:pg18"]);
        await command(["image", "inspect", "postgrest/postgrest:v16.3"]);
        await command(["network", "create", name]);
        networkCreated = true;
        await command(["run", "--pull=never", "-d", "--name", name, "--network", name,
            "-p", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql:rw,size=1g",
            "-e", "POSTGRES_PASSWORD", "supacloud-graphql-test:pg18"]);
        containers.push(name);
        await waitFor(async () => {
            await command(["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]);
            return true;
        });
        const address = await command(["port", name, "5432/tcp"]);
        if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error("Unexpected local PostgreSQL address");
        const databaseUrl = `postgres://postgres:${password}@${address}/postgres`;
        process.env["DATABASE_URL"] = databaseUrl;
        const admin = new SQL(databaseUrl);
        connections.push(admin);
        await admin.unsafe(`
            CREATE ROLE anon NOLOGIN;
            CREATE ROLE authenticated NOLOGIN;
            CREATE ROLE service_role NOLOGIN BYPASSRLS;
            CREATE ROLE outsider NOLOGIN;
            CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD '${password}';
            GRANT anon, authenticated, service_role TO authenticator;
            CREATE TABLE projects (ref text PRIMARY KEY, db_name text NOT NULL);
        `);
        async function project(ref: string, signature: "three" | "four" | "none" = "four") {
            if (!/^[a-z]+$/.test(ref)) throw new Error("Invalid fixture project");
            const dbName = `supa_${ref}`;
            await admin.unsafe(`CREATE DATABASE "${dbName}"`);
            await admin`INSERT INTO projects(ref, db_name) VALUES (${ref}, ${dbName})`;
            const db = new SQL(`postgres://postgres:${password}@${address}/${dbName}`);
            connections.push(db);
            await db.unsafe(`
                CREATE SCHEMA graphql_public;
                GRANT USAGE ON SCHEMA graphql_public TO anon, authenticated, service_role;
                CREATE TABLE public.items (id int PRIMARY KEY, owner text NOT NULL);
                INSERT INTO public.items VALUES (1, 'alice'), (2, 'bob');
                ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;
                GRANT SELECT ON public.items TO authenticated, service_role;
                CREATE POLICY items_read ON public.items FOR SELECT TO authenticated
                    USING (owner = current_setting('request.jwt.claims', true)::jsonb ->> 'sub');
                CREATE TABLE public.private_items (id int PRIMARY KEY);
            `);
            if (signature !== "none") {
                await db.unsafe(`
                    CREATE FUNCTION graphql_public.graphql(
                        "operationName" text DEFAULT NULL, query text DEFAULT NULL,
                        variables jsonb DEFAULT NULL${signature === "four" ? ", extensions jsonb DEFAULT NULL" : ""}
                    ) RETURNS jsonb LANGUAGE sql STABLE AS $$
                        SELECT '{"errors":[{"message":"GraphQL is not available on this project."}]}'::jsonb;
                    $$;
                    GRANT EXECUTE ON FUNCTION graphql_public.graphql TO anon, authenticated, service_role;
                `);
            }
            return { ref, dbName, db };
        }
        async function http(dbName: string) {
            const restName = `${name}-rest-${containers.length}`;
            await command(["run", "--pull=never", "-d", "--name", restName, "--network", name,
                "-p", "127.0.0.1::3000", "-e", "PGRST_DB_URI", "-e", "PGRST_JWT_SECRET",
                "-e", "PGRST_DB_SCHEMAS=public,graphql_public", "-e", "PGRST_DB_ANON_ROLE=anon",
                "-e", "PGRST_DB_EXTRA_SEARCH_PATH=public", "postgrest/postgrest:v16.3"], {
                PGRST_DB_URI: `postgres://authenticator:${password}@${name}:5432/${dbName}`,
                PGRST_JWT_SECRET: secret,
            });
            containers.push(restName);
            const restAddress = await command(["port", restName, "3000/tcp"]);
            if (!/^127\.0\.0\.1:\d+$/.test(restAddress)) throw new Error("Unexpected local PostgREST address");
            const url = `http://${restAddress}`;
            await waitFor(async () => (await fetch(url)).ok);
            function token(role: string, sub: string): string {
                const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
                const body = Buffer.from(JSON.stringify({ role, sub, exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url");
                return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
            }
            return async (body: unknown, role = "authenticated", sub = "alice", profile = "graphql_public") => {
                // Use the exact RPC/profile targeted by /graphql/v1; no helper installs a wrapper.
                const response = await fetch(`${url}/rpc/graphql`, {
                    method: "POST", headers: {
                        "Content-Type": "application/json", "Content-Profile": profile,
                        Authorization: `Bearer ${token(role, sub)}`,
                    }, body: JSON.stringify(body),
                });
                const payload: unknown = await response.json();
                return { status: response.status, payload };
            };
        }
        return { project, http, cleanup };
    } catch (error) {
        await cleanup();
        throw error;
    }
}
