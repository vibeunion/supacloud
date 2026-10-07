import { describe, expect, test } from "bun:test";
import { explainRlsAccess, explainRlsDatabaseError } from "../../src/services/rls-explanation";

const relation = { schema: "public", table: "todos" };

describe("RLS explanation", () => {
  test("explains a role with no applicable policy as denied", () => {
    const result = explainRlsAccess({
      role: "anon",
      relations: [relation],
      relationSecurity: [{ ...relation, rlsEnabled: true, rlsForced: false }],
      policies: [],
      rowCount: 0,
    });
    expect(result.outcome).toBe("denied");
    expect(result.reasons[0]).toContain("no policy applies");
  });

  test("distinguishes returned rows from policy-filtered empty results", () => {
    const input = {
      role: "authenticated" as const,
      relations: [relation],
      relationSecurity: [{ ...relation, rlsEnabled: true, rlsForced: false }],
      policies: [{ ...relation, name: "todos_owner", appliesToRole: true }],
    };
    expect(explainRlsAccess({ ...input, rowCount: 2 }).outcome).toBe("allowed");
    expect(explainRlsAccess({ ...input, rowCount: 0 }).outcome).toBe("filtered");
  });

  test("preserves PostgreSQL denial as the explanation source", () => {
    const result = explainRlsDatabaseError(
      Object.assign(new Error("permission denied for table todos"), { code: "42501" }),
    );
    expect(result).toMatchObject({ outcome: "denied" });
    expect(result.reasons[0]).toContain("42501");
  });
});
