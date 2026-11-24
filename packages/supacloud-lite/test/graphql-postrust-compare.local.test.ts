// @supacloud-test-isolate
// Compares one read document set on Lite and on pinned Postrust.
// Skipped unless SUPACLOUD_TEST_POSTRUST_GRAPHQL=1 and POSTRUST_BIN are set.
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { createBackend } from "../src/runtime/index.js";
import { GraphqlHandler } from "../src/runtime/graphql.js";

const enabled = process.env.SUPACLOUD_TEST_POSTRUST_GRAPHQL === "1" && (process.env.POSTRUST_BIN ?? "").length > 0;
const live = enabled ? test : test.skip;
const postrustBin = process.env.POSTRUST_BIN ?? "";
const postgresBin = process.env.POSTGRES_BIN ?? "/usr/lib/postgresql/16/bin";
const secret = randomBytes(32).toString("hex");
const password = randomBytes(18).toString("hex");

const tablesSql = `
  CREATE TABLE public.authors (id int PRIMARY KEY, name text);
  CREATE TABLE public.notes (
    id int PRIMARY KEY,
    author_id int REFERENCES public.authors(id),
    owner text NOT NULL
  );
  ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
  CREATE POLICY notes_read ON public.notes FOR SELECT TO authenticated
    USING (owner = coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub');
  GRANT SELECT ON public.authors, public.notes TO anon, authenticated;
  INSERT INTO public.authors VALUES (1, 'Alice'), (2, 'Bob'), (3, NULL);
  INSERT INTO public.notes VALUES (1, 1, 'alice'), (2, 2, 'bob');
`;
const postrustSql = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD '${password}';
  GRANT anon, authenticated TO authenticator;
  ${tablesSql}
`;

const reads = [
  "{ authors(order_by: [{ name: asc_nulls_last }]) { id name } }",
  "{ notes(where: { owner: { _eq: \"alice\" } }, order_by: [{ id: asc }], limit: 10) { id owner author { name } } }",
  "{ notes { id } }",
];
const rejected = [
  "{ notesCollection(first: 1) { edges { node { id } } } }",
  "mutation { insert_notes(objects: [{ id: 9, author_id: 1, owner: \"alice\" }]) { affected_rows } }",
];

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
  const child = Bun.spawn([bin, ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(err || out);
  return out;
}

function dataOf(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || !("data" in payload)) return undefined;
  return (payload as { data?: unknown }).data;
}

function hasErrors(payload: unknown): boolean {
  return Boolean(payload && typeof payload === "object" && "errors" in payload
    && Array.isArray((payload as { errors?: unknown }).errors)
    && (payload as { errors: unknown[] }).errors.length > 0);
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

live("Lite and Postrust return the same rows for the shared read contract", async () => {
  dataDir = await mkdtemp(join(tmpdir(), "graphql-compare-"));
  await run(join(postgresBin, "initdb"), ["-D", dataDir, "--username=postgres", "--auth=trust", "--no-sync"]);
  const port = 47000 + Math.floor(Math.random() * 1000);
  await run(join(postgresBin, "pg_ctl"), [
    "-D", dataDir, "-l", join(dataDir, "server.log"), "-w", "start",
    "-o", `-k ${dataDir} -p ${port} -c listen_addresses=127.0.0.1`,
  ]);
  await run(join(postgresBin, "psql"), [
    "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-c", postrustSql,
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
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${restPort}/`)).ok) break;
    } catch { /* still binding */ }
    await Bun.sleep(100);
    if (attempt === 49) throw new Error("Postrust did not become ready");
  }

  const backend = await createBackend({ startRuntimeServices: false });
  try {
    await backend.db.exec(tablesSql);
    const handler = new GraphqlHandler(backend.db, backend.graphql);
    async function lite(document: string, role: string, sub: string) {
      const response = await handler.handle(new Request("http://local/graphql/v1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: document }),
      }), { role, claims: { role, sub } });
      return await response.json() as unknown;
    }
    async function hosted(document: string, role: string, sub: string) {
      const response = await fetch(`http://127.0.0.1:${restPort}/v1/graphql`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token(role, sub)}`,
        },
        body: JSON.stringify({ query: document }),
      });
      expect(response.status).toBe(200);
      return await response.json() as unknown;
    }

    for (const [role, sub] of [["authenticated", "alice"], ["anon", "alice"]] as const) {
      for (const document of reads) {
        const left = dataOf(await lite(document, role, sub));
        const right = dataOf(await hosted(document, role, sub));
        expect(left, document).toEqual(right);
      }
    }
    for (const document of rejected) {
      const left = await lite(document, "authenticated", "alice");
      const right = await hosted(document, "authenticated", "alice");
      expect(hasErrors(left), document).toBe(true);
      expect(hasErrors(right), document).toBe(true);
      expect(JSON.stringify(dataOf(left) ?? null)).not.toContain("edges");
      expect(JSON.stringify(dataOf(right) ?? null)).not.toContain("edges");
    }
  } finally {
    await backend.close();
  }
}, 90_000);
