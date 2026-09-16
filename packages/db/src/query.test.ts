import { expect, expectTypeOf, test } from "bun:test";
import { decodePostgrestQuery, defineReadQuery, type QueryEvent } from "./query";
import { analyzeSql, assertReadSql, planSqlImpact } from "./sql-analysis";

const text = (value: unknown) => { if (typeof value !== "string") throw new Error("invalid"); return value; };

test("read contract validates input, authorizes each request and observes decoded results only", async () => {
  const events: QueryEvent[] = [];
  let calls = 0;
  const query = defineReadQuery({
    name: "orders.detail", input: text, result: text, slowMs: 0,
    authorize: (tenant: string, input) => tenant === "tenant-a" && input === "private-id" ? "allow" : "deny",
    execute: async () => { calls++; return "private-result"; },
    observe: (event) => { events.push(event); },
  });
  expectTypeOf(await query.execute("tenant-a", "private-id")).toEqualTypeOf<string>();
  await expect(query.executeUnknown("tenant-a", 42)).rejects.toMatchObject({ code: "QUERY_INPUT_INVALID" });
  await expect(query.execute("tenant-b", "private-id")).rejects.toMatchObject({ code: "QUERY_REJECTED" });
  expect(calls).toBe(1);
  expect(events.map((event) => event.phase)).toEqual(["started", "succeeded"]);
  expect(events[1]?.slow).toBe(true);
  expect(JSON.stringify(events)).not.toContain("private");
});

test("invalid results fail closed and telemetry cannot change an outcome", async () => {
  const query = defineReadQuery({
    name: "orders.list", input: text, result: text,
    authorize: () => "allow", execute: async () => 42,
    observe: async () => { throw new Error("monitor offline"); },
  });
  await expect(query.execute({}, "id")).rejects.toMatchObject({ code: "QUERY_RESULT_INVALID" });
});

test("PostgREST selected result type is preserved and HTTP errors are never decoded", async () => {
  const query = Promise.resolve({ data: { id: "1" }, error: null });
  const decode = (value: unknown) => {
    if (!value || typeof value !== "object" || !("id" in value)) throw new Error("missing id");
    return { id: text(value.id) };
  };
  const result = await decodePostgrestQuery(query, decode);
  expectTypeOf(result).toEqualTypeOf<{ id: string }>();
  expect(result).toEqual({ id: "1" });
  let decoded = false;
  await expect(decodePostgrestQuery(Promise.resolve({ data: null, error: { message: "secret" } }), () => {
    decoded = true; return null;
  })).rejects.toMatchObject({ code: "QUERY_TRANSPORT_FAILED" });
  expect(decoded).toBe(false);
  const negative = () => {
    // @ts-expect-error Decoder must match the selected PostgREST result.
    decodePostgrestQuery(query, () => ({ id: 1 }));
  };
  void negative;
});

test("native PostgreSQL fingerprints ignore literal values; read admission rejects write CTEs and multi statements", async () => {
  const first = await analyzeSql("SELECT * FROM public.orders WHERE id = 'secret-one'");
  const second = await analyzeSql("SELECT * FROM public.orders WHERE id = 'secret-two'");
  expect(first.fingerprint).toBe(second.fingerprint);
  expect(JSON.stringify(first)).not.toContain("secret");
  expect(await assertReadSql("WITH r AS (SELECT 1) SELECT * FROM r")).toHaveLength(16);
  for (const sql of [
    "SELECT 1; DELETE FROM public.orders", "WITH d AS (DELETE FROM public.orders RETURNING *) SELECT * FROM d",
    "SELECT * FROM public.orders FOR UPDATE", "SELECT * INTO public.copy FROM public.orders",
  ]) await expect(assertReadSql(sql)).rejects.toThrow();
});

test("migration impact follows views transitively, detects history rewrites and flags opaque SQL", async () => {
  const sources = [
    { id: "001", owner: "orders", sql: "CREATE TABLE public.orders(id int PRIMARY KEY)" },
    { id: "002", owner: "reports", sql: "CREATE VIEW public.summary AS SELECT id FROM public.orders" },
    { id: "003", owner: "reports", sql: "CREATE VIEW public.dashboard AS SELECT id FROM public.summary" },
  ];
  const baseline = await planSqlImpact(sources);
  const plan = await planSqlImpact([...sources,
    { id: "004", owner: "orders", sql: "ALTER TABLE public.orders ADD COLUMN state text" },
  ], baseline.migrations);
  expect(plan.errors).toEqual([]);
  expect(plan.affectedObjects).toEqual([
    'relation:"public"."dashboard"', 'relation:"public"."orders"', 'relation:"public"."summary"',
  ]);
  expect(plan.affectedMigrations).toEqual(["001", "002", "003", "004"]);
  expect((await planSqlImpact([...sources].reverse(), baseline.migrations)).errors.length).toBeGreaterThan(0);
  expect((await planSqlImpact([...sources].reverse())).errors.length).toBeGreaterThan(0);
  expect((await analyzeSql("DO $$ BEGIN EXECUTE 'DROP TABLE x'; END $$")).review.length).toBeGreaterThan(0);
});
