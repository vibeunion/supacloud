import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("supabase bootstrap schema", () => {
  test("does not switch SQL role inside set_request_context", () => {
    const schemaPath = resolve(
      import.meta.dir,
      "../../src/db/schemas/supabase.sql",
    );
    const schema = readFileSync(schemaPath, "utf8");
    const start = schema.indexOf(
      "CREATE OR REPLACE FUNCTION public.set_request_context()",
    );
    const end = schema.indexOf("$$ LANGUAGE plpgsql SECURITY DEFINER;", start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const fnBody = schema.slice(start, end);
    expect(fnBody).toContain(
      "PERFORM set_config('request.jwt.claim.role', role_claim, true);",
    );
    expect(fnBody).not.toContain("SET LOCAL ROLE");
  });
});
