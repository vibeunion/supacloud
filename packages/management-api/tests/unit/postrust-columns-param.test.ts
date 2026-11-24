import { describe, expect, test } from "bun:test";
import { normalizePostgrestColumnsParam } from "../../src/routes/sdk-proxy";

describe("Postrust columns parameter", () => {
  test("strips the quotes supabase-js adds around bulk-insert column names", () => {
    expect(normalizePostgrestColumnsParam("\"task\",\"is_complete\"")).toBe("task,is_complete");
    expect(normalizePostgrestColumnsParam("task,is_complete")).toBe("task,is_complete");
    expect(normalizePostgrestColumnsParam("\"a\"\"b\"")).toBe("a\"b");
  });
});
