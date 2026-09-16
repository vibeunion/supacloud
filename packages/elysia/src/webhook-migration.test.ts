import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { COMMAND_PERSISTENCE_SQL } from "@supacloud/db";
import { createBunCommandDatabase } from "@supacloud/db/bun";
import { decodeDurableCommandReceipt } from "@supacloud/contracts";
import { checkProject } from "@supacloud/compiler";
import { ApplicationError, executeJob } from "./index";
import { createCommandRecoveryJob } from "@supacloud/commands";
import { webhookCompileOptions } from "./generate-webhook-example";
import { createWebhookMigrationExample, decodeWebhookInput, WEBHOOK_EXAMPLE_SQL } from "./webhook-migration-example";

const connection = process.env["SUPACLOUD_COMMAND_TEST_URL"];
const suite = connection ? describe : describe.skip;
test("Webhook acceptance runs current compiler-generated factories and real controller invokers", async () => {
  expect((await checkProject(webhookCompileOptions)).upToDate).toBe(true);
});
test("bounded recovery uses the existing Job execution path", async () => {
  const handler = createCommandRecoveryJob({
    store: { claim: async () => [], release: async () => {}, redactCompleted: async () => 0 },
    tenantId: "tenant", principal: { subject: "worker" }, authorize: () => "allow",
    commands: { "remote.update.v1": { recover: async () => null } },
    batchSize: 10, leaseMs: 60_000, retryAfterMs: 60_000, alertAfterMs: 3600_000, inputRetentionMs: 86400_000,
  });
  const services = { recovery: handler };
  const report = await executeJob(
    { name: "recovery", createServices: () => services, controllers: [] }, services,
    { name: "command.recovery", className: "Recovery", serviceKey: "recovery", scope: "application" },
    undefined, { subject: "worker" },
  );
  expect(report).toMatchObject({ claimed: 0, failed: 0, redacted: 0 });
});
suite("Webhook full module migration with native PostgreSQL", () => {
  let sql: SQL;
  beforeAll(async () => {
    if (!connection) throw new Error("Missing isolated test database");
    const url = new URL(connection);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/supacloud_commands_test") throw new Error("Unsafe database target");
    sql = new SQL(connection);
    await sql.unsafe(COMMAND_PERSISTENCE_SQL);
    await sql.unsafe(WEBHOOK_EXAMPLE_SQL);
  });
  afterAll(async () => { await sql?.close(); });

  async function fixture() {
    const identity = { tenantId: crypto.randomUUID(), actorId: crypto.randomUUID() };
    const input = { id: crypto.randomUUID(), enabled: true };
    await sql.unsafe("INSERT INTO public.webhook_module_example(tenant_id,id,enabled) VALUES($1,$2,false)", [identity.tenantId, input.id]);
    let allowed = true, auditAvailable = true, authorizationAvailable = true;
    const example = createWebhookMigrationExample({
      database: createBunCommandDatabase(sql),
      authenticate: async (request) => {
        if (request.headers.get("authorization") !== "Bearer test-session") throw new ApplicationError("Unauthenticated", { status: 401 });
        return identity;
      },
      authorize: async () => {
        if (!authorizationAvailable) throw new Error("Policy connection unavailable");
        return allowed ? "allow" : "deny";
      },
      writeAudit: async () => { if (!auditAvailable) throw new Error("Audit offline"); },
    });
    const key = crypto.randomUUID();
    const request = (body: unknown = input, path = "/webhooks/update", headers: Record<string, string> = {}) =>
      example.app.handle(new Request(`http://localhost${path}`, {
        method: "POST", headers: {
          "content-type": "application/json", authorization: "Bearer test-session", "idempotency-key": key, ...headers,
        }, body: JSON.stringify(body),
      }));
    const count = async () => {
      const rows: unknown = await sql.unsafe<unknown>("SELECT writes FROM public.webhook_module_example WHERE tenant_id=$1 AND id=$2", [identity.tenantId, input.id]);
      if (!Array.isArray(rows)) throw new Error("Invalid rows");
      const row: unknown = rows[0];
      if (!row || typeof row !== "object" || !("writes" in row) || typeof row.writes !== "number") throw new Error("Invalid count");
      return row.writes;
    };
    return { ...example, identity, input, key, request, count,
      revoke: () => { allowed = false; }, failAudit: () => { auditAvailable = false; },
      restoreAudit: () => { auditAvailable = true; },
      failAuthorization: () => { authorizationAvailable = false; },
    };
  }
  test("HTTP duplicates, receipt lookup and decoder share one authoritative committed result", async () => {
    const f = await fixture();
    const responses = await Promise.all(Array.from({ length: 5 }, () => f.request()));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    for (const response of responses) {
      const raw: unknown = await response.json();
      expect(decodeDurableCommandReceipt(raw, decodeWebhookInput)).toMatchObject({
        status: "confirmed", audit: "complete", operationId: f.key, result: f.input,
      });
    }
    expect(await f.count()).toBe(1);
    const lookup = await f.app.handle(new Request(`http://localhost/webhooks/receipts/${f.key}`, {
      headers: { authorization: "Bearer test-session" },
    }));
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({ receipt: { status: "confirmed", operationId: f.key } });
    expect((await f.request({ ...f.input, enabled: false })).status).toBe(409);
    f.revoke();
    expect((await f.request()).status).toBe(403);
    expect(await f.count()).toBe(1);
  });
  test("missing identity, invalid body and missing operation key cannot write", async () => {
    const f = await fixture();
    expect((await f.request(f.input, undefined, { authorization: "" })).status).toBe(401);
    expect((await f.request({ ...f.input, enabled: "true" })).status).toBe(422);
    expect((await f.request({ ...f.input, actorId: "forged" })).status).toBe(422);
    expect((await f.request(f.input, undefined, { "idempotency-key": "" })).status).toBe(400);
    expect(await f.count()).toBe(0);
  });
  test("authorization infrastructure failure is 503 unavailable, not 403 rejection", async () => {
    const f = await fixture();
    f.failAuthorization();
    const response = await f.request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "COMMAND_UNAVAILABLE" });
    expect(await f.count()).toBe(0);
  });
  test("audit outage rolls back HTTP business write and same-key recovery commits exactly once", async () => {
    const f = await fixture();
    f.failAudit();
    expect((await f.request()).status).toBe(503);
    expect(await f.count()).toBe(0);
    const lookup = await f.app.handle(new Request(`http://localhost/webhooks/receipts/${f.key}`, {
      headers: { authorization: "Bearer test-session" },
    }));
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toEqual({ receipt: null });
    f.restoreAudit();
    expect((await f.request()).status).toBe(200);
    expect(await f.count()).toBe(1);
  });
});
