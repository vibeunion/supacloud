import { describe, expect, test } from "bun:test";
import { pgredisExtensionPolicy } from "./extension-policy";

describe("pgredis PostgreSQL extension policy", () => {
  test("keeps the KV data plane independent from optional extensions", () => {
    expect(pgredisExtensionPolicy()).toEqual({
      required: [],
      recommended: ["pg_stat_statements", "pg_cron"],
      optional: ["pg_ivm"],
    });
  });
});
