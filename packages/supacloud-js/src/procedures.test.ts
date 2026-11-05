import { expect, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import { createSupaCloudClient, createProcedureClient } from "./index.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

test("SDK binding retains procedure identities and can be rebound without mutating the base", async () => {
  const query = Object.assign(async (input: { params: { id: string } }) => ({ id: input.params.id }), {
    __supacloudInput: undefined as { params: { id: string } } | undefined,
    __supacloudProcedure: { key: "Items.get", kind: "query" as const, method: "GET", path: "/items/:id", idempotency: "none" as const },
  });
  const generated = { procedureClient: { items: { get: { query } } } };
  const supabase = createClient("https://example.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const base = createSupaCloudClient({ supabase, projectRef: "p", managementApiUrl: "https://example.test" });
  type BaseApplicationLane = Assert<Equal<typeof base.app, undefined>>;
  expect(base.compat.supabase).toBe(supabase);
  expect(base.app).toBeUndefined();
  expect(base.procedures).toBeUndefined();
  expect(() => base.queryAdapter({ keyPrefix: ["p", "actor"] })).toThrow("No procedure client attached");
  const bound = base.withClient(generated);
  type BoundApplicationLane = Assert<Equal<typeof bound.app.procedures, typeof generated.procedureClient>>;
  expect(bound.compat.supabase).toBe(supabase);
  expect(bound.app.procedures.items.get.query).toBe(query);
  expect(bound.procedures.items.get.query).toBe(query);
  expect(createProcedureClient(generated)).toBe(generated.procedureClient);
  expect(await bound.queryAdapter({ keyPrefix: ["p", "actor"] }).items.get
    .queryOptions({ params: { id: "1" } }).queryFn({})).toEqual({ id: "1" });
  expect(await bound.app.queryAdapter({ keyPrefix: ["p", "actor"] }).items.get
    .queryOptions({ params: { id: "2" } }).queryFn({})).toEqual({ id: "2" });
  const rebound = base.withApp(generated);
  expect(rebound.app.procedures.items.get.query).toBe(query);
  const configured = createSupaCloudClient({
    supabase, projectRef: "p", managementApiUrl: "https://example.test", apiClient: generated,
  });
  expect(configured.app?.procedures.items.get.query).toBe(query);
  expect(configured.procedures.items.get.query).toBe(query);
  expect(base.procedures).toBeUndefined();
});
