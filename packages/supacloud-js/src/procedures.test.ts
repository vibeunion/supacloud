import { expect, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import { createSupaCloudClient, createProcedureClient } from "./index.js";

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
  expect(base.procedures).toBeUndefined();
  expect(() => base.queryAdapter({ keyPrefix: ["p", "actor"] })).toThrow("No procedure");
  const bound = base.withClient(generated);
  expect(bound.procedures.items.get.query).toBe(query);
  expect(createProcedureClient(generated)).toBe(generated.procedureClient);
  expect(await bound.queryAdapter({ keyPrefix: ["p", "actor"] }).items.get
    .queryOptions({ params: { id: "1" } }).queryFn({})).toEqual({ id: "1" });
  const configured = createSupaCloudClient({
    supabase, projectRef: "p", managementApiUrl: "https://example.test", apiClient: generated,
  });
  expect(configured.procedures.items.get.query).toBe(query);
  expect(base.procedures).toBeUndefined();
});
