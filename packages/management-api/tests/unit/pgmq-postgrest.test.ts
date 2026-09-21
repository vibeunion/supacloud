// @supacloud-test-isolate
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createSupaCloudClient, SupaCloudQueueError } from "../../../supacloud-js/src/index";
import { withNativePostgres, waitForPostgresFixture } from "../helpers/native-postgres";

const pgImage = "ghcr.io/pgmq/pg18-pgmq@sha256:bfb3537068ce453609744518ece92b178ac89dff53747d47ca6fab91c2fc66a6";
const restImage = "postgrest/postgrest@sha256:85258123312dc496ad4c2ed832154a65e9746f84df0d6d09b44229ff9230c08e";
const moduleSql = await readFile(new URL("../../src/db/sql-modules/pgmq-public.sql", import.meta.url), "utf8");
const secret = "synthetic-pgmq-postgrest-jwt-secret-not-for-production";

async function docker(...args: string[]): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`PostgREST fixture command failed: ${stderr}`);
  return stdout.trim();
}

function token(): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ role: "anon", exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url");
  const data = `${header}.${payload}`;
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}

test("running PostgREST refreshes legacy RPCs and real SDK preserves receipts, payloads and bigints", async () => {
  await withNativePostgres(async (db, _url, databaseName) => {
    await db.unsafe(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE ROLE api LOGIN PASSWORD 'synthetic'; GRANT anon TO api;
    `);
    await db.unsafe(`
      CREATE EXTENSION pgmq;
      CREATE SCHEMA pgmq_public;
      GRANT USAGE ON SCHEMA pgmq_public TO anon;
      CREATE FUNCTION pgmq_public.send(queue_name text, message jsonb, sleep_seconds integer DEFAULT 0)
      RETURNS SETOF bigint LANGUAGE sql SECURITY DEFINER SET search_path = ''
      AS $$ SELECT * FROM pgmq.send(queue_name, message, sleep_seconds) $$;
      CREATE FUNCTION pgmq_public.send_batch(queue_name text, messages jsonb[], sleep_seconds integer DEFAULT 0)
      RETURNS SETOF bigint LANGUAGE sql SECURITY DEFINER SET search_path = ''
      AS $$ SELECT * FROM pgmq.send_batch(queue_name, messages, sleep_seconds) $$;
      CREATE FUNCTION pgmq_public.read(queue_name text, sleep_seconds integer, n integer)
      RETURNS SETOF pgmq.message_record LANGUAGE sql SECURITY DEFINER SET search_path = ''
      AS $$ SELECT * FROM pgmq.read(queue_name, sleep_seconds, n) $$;
      CREATE FUNCTION pgmq_public.pop(queue_name text)
      RETURNS SETOF pgmq.message_record LANGUAGE sql SECURITY DEFINER SET search_path = ''
      AS $$ SELECT * FROM pgmq.pop(queue_name) $$;
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgmq_public FROM PUBLIC;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq_public TO anon;
    `);
    await db`SELECT pgmq.create('jobs')`;
    await db`SELECT pgmq.create('upgrade_probe')`;
    await db`SELECT setval(pg_get_serial_sequence('pgmq.q_jobs', 'msg_id'), 9007199254740992, true)`;
    const network = `supacloud-pgmq-rest-${crypto.randomUUID()}`;
    const restName = `${network}-api`;
    let connected = false;
    let started = false;
    await docker("network", "create", network);
    try {
      await docker("network", "connect", network, databaseName);
      connected = true;
      await docker("run", "--detach", "--rm", "--name", restName, "--network", network,
        "--publish", "127.0.0.1::3000",
        "--env", `PGRST_DB_URI=postgres://api:synthetic@${databaseName}:5432/fixture`,
        "--env", "PGRST_DB_SCHEMAS=pgmq_public",
        "--env", "PGRST_DB_ANON_ROLE=anon",
        "--env", `PGRST_JWT_SECRET=${secret}`, restImage);
      started = true;
      const mapping = await docker("port", restName, "3000/tcp");
      const port = /^127\.0\.0\.1:(\d+)$/.exec(mapping)?.[1];
      if (!port) throw new Error("Expected loopback PostgREST port");
      const base = `http://127.0.0.1:${port}`;
      await waitForPostgresFixture(async () => {
        try {
          const response = await fetch(base, { signal: AbortSignal.timeout(1000) });
          await response.arrayBuffer();
          return response.ok;
        } catch { return false; }
      });
      const probe = (fn: string, args: Record<string, unknown>) => fetch(`${base}/rpc/${fn}`, {
        method: "POST", headers: {
          authorization: `Bearer ${token()}`, "content-type": "application/json", "content-profile": "pgmq_public",
        }, body: JSON.stringify(args), signal: AbortSignal.timeout(1000),
      });
      const oldReceipt = await probe("send", { queue_name: "upgrade_probe", message: {} });
      expect(oldReceipt.status).toBe(200);
      expect(await oldReceipt.json()).toEqual([1]);
      const beforeMigration = await probe("require_read_count", { value: 1 });
      expect(beforeMigration.status).toBe(404);
      await beforeMigration.arrayBuffer();
      await db.begin(async tx => { await tx.unsafe(moduleSql); });
      await waitForPostgresFixture(async () => {
        const response = await probe("require_read_count", { value: 1 });
        const body: unknown = await response.json();
        return response.status === 200 && body === 1;
      });
      const newReceipt = await probe("send", { queue_name: "upgrade_probe", message: {} });
      expect(newReceipt.status).toBe(200);
      expect(await newReceipt.json()).toEqual(["2"]);
      const calls: Array<{ path: string; status: number; body: unknown }> = [];
      const transport = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        // Supabase normally reaches PostgREST through the gateway's /rest/v1 prefix.
        if (!url.pathname.startsWith("/rest/v1/")) throw new Error("Unexpected SDK request");
        url.pathname = url.pathname.slice("/rest/v1".length);
        const response = await fetch(new Request(url, request));
        const body: unknown = await response.clone().json();
        calls.push({ path: url.pathname, status: response.status, body });
        return response;
      }, { preconnect: globalThis.fetch.preconnect });
      const supabase = createClient(base, token(), {
        global: { fetch: transport },
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      });
      const sdk = createSupaCloudClient({
        supabase, managementApiUrl: "http://127.0.0.1:1", projectRef: "fixture",
        getAccessToken: () => { throw new Error("Unexpected Management API lookup"); },
      });
      const queue = sdk.queue("jobs");
      const first = await queue.send({ nested: [false, null, 1], text: '{"raw":true}' });
      expect(first.msg_id).toBe("9007199254740993");
      expect(calls[0]).toMatchObject({ path: "/rpc/send", status: 200, body: ["9007199254740993"] });
      const batch = await queue.sendBatch(["plain string", [null, true]]);
      expect(batch.map(message => message.msg_id)).toEqual(["9007199254740994", "9007199254740995"]);
      const read = await queue.read({ count: 1, sleep_seconds: 60 });
      expect(read[0]).toMatchObject({ msg_id: first.msg_id, payload: { nested: [false, null, 1], text: '{"raw":true}' } });
      expect(calls.find(call => call.path === "/rpc/read")?.body).toMatchObject([{ msg_id: first.msg_id }]);
      expect((await queue.archive(first.msg_id)).success).toBe(true);
      expect((await queue.archive(first.msg_id)).success).toBe(false);
      const popped = await queue.pop();
      expect(popped).toMatchObject({ msg_id: "9007199254740994", payload: "plain string" });
      expect((await queue.delete("9007199254740995")).success).toBe(true);
      expect((await queue.delete("9007199254740995")).success).toBe(false);
      expect(await queue.receive()).toBeNull();
      expect(await queue.pop()).toBeNull();
      const before = calls.length;
      await expect(sdk.queue("missing").send({})).rejects.toBeInstanceOf(SupaCloudQueueError);
      expect(calls.length - before).toBe(1);
      const remaining = await db`SELECT count(*)::integer AS count FROM pgmq.q_jobs`;
      expect(remaining[0].count).toBe(0);
      const protectedMessage = await queue.send({ protected: true });
      const beforeInvalid = await db`SELECT msg_id::text AS id, read_ct, vt, message FROM pgmq.q_jobs`;
      const sequenceBefore = await db`SELECT last_value::text AS value FROM pgmq.q_jobs_msg_id_seq`;
      const rawRpc = async (fn: string, args: Record<string, unknown>) => {
        const response = await fetch(`${base}/rpc/${fn}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token()}`, "content-type": "application/json",
            "content-profile": "pgmq_public",
          },
          body: JSON.stringify(args),
        });
        const body: unknown = await response.json();
        return { response, body };
      };
      for (const value of [0.5, 1.5, -1, null, 2147483648, "1.5", "not-a-number", true]) {
        for (const [fn, args] of [
          ["send", { queue_name: "jobs", message: {}, sleep_seconds: value }],
          ["send_batch", { queue_name: "jobs", messages: [{}], sleep_seconds: value }],
          ["read", { queue_name: "jobs", sleep_seconds: value, n: 1 }],
        ] as const) {
          const { response, body } = await rawRpc(fn, args);
          expect(response.status, `${fn} accepted invalid seconds ${JSON.stringify(value)}`).toBe(400);
          expect(body).toMatchObject({ code: expect.stringMatching(/^22/) });
        }
      }
      for (const value of [0.5, 1.5, 0, -1, null, 10001, "1.5", true]) {
        const { response } = await rawRpc("read", { queue_name: "jobs", sleep_seconds: 0, n: value });
        expect(response.status, `read accepted invalid count ${JSON.stringify(value)}`).toBe(400);
      }
      for (const value of [0.5, 1.5, 0, -1, null, "9223372036854775808", "1.5", true]) {
        for (const fn of ["archive", "delete"]) {
          const { response } = await rawRpc(fn, { queue_name: "jobs", message_id: value });
          expect(response.status, `${fn} accepted invalid ID ${JSON.stringify(value)}`).toBe(400);
        }
      }
      const afterInvalid = await db`SELECT msg_id::text AS id, read_ct, vt, message FROM pgmq.q_jobs`;
      const sequenceAfter = await db`SELECT last_value::text AS value FROM pgmq.q_jobs_msg_id_seq`;
      expect(Array.from(afterInvalid)).toEqual(Array.from(beforeInvalid));
      expect(sequenceAfter[0].value).toBe(sequenceBefore[0].value);
      expect((await queue.delete(protectedMessage.msg_id)).success).toBe(true);
    } finally {
      try {
        if (started) await docker("rm", "--force", restName);
      } finally {
        try {
          if (connected) await docker("network", "disconnect", network, databaseName);
        } finally { await docker("network", "rm", network); }
      }
    }
  }, { image: pgImage });
}, 60_000);
