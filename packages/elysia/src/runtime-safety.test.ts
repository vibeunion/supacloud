import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { COMMAND_PERSISTENCE_SQL } from "@supacloud/db";
import { createBunCommandDatabase } from "@supacloud/db/bun";
import { ApplicationError, createApplication, type CompiledModule } from "./index";
import { createWebhookMigrationExample, WEBHOOK_EXAMPLE_SQL } from "./webhook-migration-example";

const connection = process.env["SUPACLOUD_COMMAND_TEST_URL"];
if (!connection && process.env["SUPACLOUD_REQUIRE_RUNTIME_SAFETY"] === "1") {
  throw new Error("runtime-safety requires SUPACLOUD_COMMAND_TEST_URL; refusing a skipped acceptance run");
}
const suite = connection ? describe : describe.skip;

suite("real HTTP and PostgreSQL runtime safety", () => {
  let sql: SQL;
  beforeAll(async () => {
    if (!connection) throw new Error("Missing dedicated test database");
    const url = new URL(connection);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/supacloud_commands_test") {
      throw new Error("Use a dedicated loopback supacloud_commands_test database");
    }
    sql = new SQL(connection);
    await sql.unsafe(COMMAND_PERSISTENCE_SQL);
    await sql.unsafe(WEBHOOK_EXAMPLE_SQL);
  });
  afterAll(async () => { await sql?.close(); });

  async function fixture(overlap = 0) {
    const tenantA = crypto.randomUUID(), tenantB = crypto.randomUUID();
    const identities = new Map([
      ["token-a", { tenantId: tenantA, actorId: "actor-a" }],
      ["token-b", { tenantId: tenantA, actorId: "actor-b" }],
      ["token-c", { tenantId: tenantB, actorId: "actor-a" }],
    ]);
    const id = crypto.randomUUID(), key = crypto.randomUUID();
    for (const tenant of [tenantA, tenantB]) {
      await sql.unsafe("INSERT INTO public.webhook_module_example(tenant_id,id,enabled) VALUES($1,$2,false)", [tenant, id]);
    }
    let denied = false, failAudit = false, arriving = 0;
    const barrier = Promise.withResolvers<void>();
    const { app } = createWebhookMigrationExample({
      database: createBunCommandDatabase(sql),
      authenticate: async (request) => {
        const identity = identities.get(request.headers.get("authorization")?.replace("Bearer ", "") ?? "");
        if (!identity) throw new ApplicationError("Unauthenticated", { status: 401 });
        if (overlap > 0 && ++arriving <= overlap) {
          if (arriving === overlap) barrier.resolve();
          await barrier.promise;
        }
        return identity;
      },
      authorize: async () => denied ? "deny" : "allow",
      writeAudit: async () => { if (failAudit) throw new Error("Injected audit failure"); },
    });
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: (request) => app.handle(request),
    });
    const request = (token: string, operationKey = key, body: unknown = { id, enabled: true }) =>
      fetch(new URL("/webhooks/update", server.url), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": operationKey },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
      });
    const lookup = (token: string) => fetch(new URL(`/webhooks/receipts/${key}`, server.url), {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
    });
    const state = async () => ({
      business: await sql.unsafe<unknown>(
        "SELECT tenant_id,writes FROM public.webhook_module_example WHERE id=$1 ORDER BY tenant_id", [id]),
      receipts: await sql.unsafe<unknown>(
        "SELECT count(*)::integer AS count FROM supacloud_commands.execution_audit WHERE operation_key=$1", [key]),
    });
    return {
      tenantA, tenantB, key, id, request, lookup, state,
      deny: () => { denied = true; },
      failAudit: () => { failAudit = true; },
      restoreAudit: () => { failAudit = false; },
      stop: () => server.stop(true),
    };
  }

  test("overlapping identities and duplicate keys isolate request scopes, tenants and actors", async () => {
    const f = await fixture(12);
    try {
      const responses = await Promise.all(Array.from({ length: 12 }, (_, index) =>
        f.request(["token-a", "token-b", "token-c"][index % 3] ?? "invalid")));
      const dispatches = new Map<string, Set<string>>();
      for (const [index, response] of responses.entries()) {
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        if (!body || typeof body !== "object" || !("dispatchKey" in body) || typeof body.dispatchKey !== "string") {
          throw new Error("Missing durable dispatch key");
        }
        const identity = String(index % 3);
        const keys = dispatches.get(identity) ?? new Set<string>();
        keys.add(body.dispatchKey);
        dispatches.set(identity, keys);
      }
      expect([...dispatches.values()].map((keys) => keys.size)).toEqual([1, 1, 1]);
      expect(new Set([...dispatches.values()].flatMap((keys) => [...keys])).size).toBe(3);
      const state = await f.state();
      expect(state.business).toEqual([
        { tenant_id: f.tenantA, writes: 2 }, { tenant_id: f.tenantB, writes: 1 },
      ].sort((a, b) => a.tenant_id.localeCompare(b.tenant_id)));
      expect(state.receipts).toEqual([{ count: 3 }]);
    } finally { await f.stop(); }
  }, 20_000);

  test("denied identity cannot write or replay another actor's receipt", async () => {
    const f = await fixture();
    try {
      const success = await f.request("token-a");
      expect(success.status).toBe(200);
      await success.arrayBuffer();
      for (const token of ["token-b", "token-c"]) {
        const response = await f.lookup(token);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ receipt: null });
      }
      const before = await f.state();
      f.deny();
      for (const key of [f.key, crypto.randomUUID()]) {
        const response = await f.request("token-a", key);
        expect({ status: response.status, body: await response.json() }).toMatchObject({
          status: 403, body: { code: "COMMAND_REJECTED" },
        });
      }
      const lookup = await f.lookup("token-a");
      expect(lookup.status).toBe(403);
      await lookup.arrayBuffer();
      expect(await f.state()).toEqual(before);
    } finally { await f.stop(); }
  });

  test("every overlapping HTTP request gets its own provider and teardown", async () => {
    const entered = Promise.withResolvers<void>();
    const destroyed = Promise.withResolvers<void>();
    const scopes = new Set<Record<string, unknown>>();
    const disposed = new Set<Record<string, unknown>>();
    const module: CompiledModule = {
      name: "scope-safety", createServices: () => ({}),
      createRequestScope: async (_services, context) => {
        if (typeof context !== "string") throw new Error("Invalid context");
        const instance = crypto.randomUUID();
        const scope = {
          controller: {
            read: async () => {
              await entered.promise;
              return { subject: context, instance };
            },
          },
        };
        scopes.add(scope);
        if (scopes.size === 6) entered.resolve();
        return scope;
      },
      destroyRequestScope: async (scope) => {
        expect(disposed.has(scope)).toBe(false);
        disposed.add(scope);
        if (disposed.size === 6) destroyed.resolve();
      },
      controllers: [{
        path: "/scope", serviceKey: "controller", scope: "request",
        routes: [{ method: "GET", path: "", handler: "read" }],
      }],
    };
    const app = createApplication({
      modules: [module], requestContext: (request) => request.headers.get("authorization"),
    });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.handle(request) });
    try {
      const bodies = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
        const response = await fetch(new URL("/scope", server.url), {
          headers: { authorization: `tenant-${index % 2}:actor-${index}` },
          signal: AbortSignal.timeout(5_000),
        });
        expect(response.status).toBe(200);
        const body: unknown = await response.json();
        expect(body).toMatchObject({ subject: `tenant-${index % 2}:actor-${index}` });
        return body;
      }));
      expect(bodies).toHaveLength(6);
      const timeout = setTimeout(() => destroyed.reject(new Error("Request scopes were not disposed")), 5_000);
      try { await destroyed.promise; } finally { clearTimeout(timeout); }
      expect(scopes.size).toBe(6);
      expect(disposed).toEqual(scopes);
    } finally { await server.stop(true); }
  }, 10_000);

  test("audit failure rolls back writes and receipt; same-key retry commits once", async () => {
    const f = await fixture();
    try {
      const initial = await f.state();
      f.failAudit();
      const failed = await f.request("token-a");
      expect({ status: failed.status, body: await failed.json() }).toMatchObject({
        status: 503, body: { code: "COMMAND_OUTCOME_UNKNOWN" },
      });
      expect(await f.state()).toEqual(initial);
      expect(await (await f.lookup("token-a")).json()).toEqual({ receipt: null });
      f.restoreAudit();
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await f.request("token-a");
        expect(response.status).toBe(200);
        await response.arrayBuffer();
      }
      const state = await f.state();
      expect(state.business).toEqual([
        { tenant_id: f.tenantA, writes: 1 }, { tenant_id: f.tenantB, writes: 0 },
      ].sort((a, b) => a.tenant_id.localeCompare(b.tenant_id)));
      expect(state.receipts).toEqual([{ count: 1 }]);
    } finally { await f.stop(); }
  });
});
