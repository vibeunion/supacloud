import { describe, expect, test } from "bun:test";
import {
  buildJitLoginRole,
  isJitTargetRoleAllowed,
  normalizeJitExpiry,
  normalizeJitRole,
} from "../../src/services/jit-database-access.service";

describe("temporary database access helpers", () => {
  test("normalizes an existing PostgreSQL role name without allowing injection", () => {
    expect(normalizeJitRole("app_reader")).toBe("app_reader");
    expect(() => normalizeJitRole("postgres; drop role app_reader"))
      .toThrow("PostgreSQL identifier");
    expect(() => normalizeJitRole("supabase_admin")).toThrow("managed service role");
  });

  test("bounds temporary access to 90 days", () => {
    const now = Date.parse("2026-07-28T00:00:00Z");
    expect(normalizeJitExpiry(now + 60_000, now).toISOString()).toBe("2026-07-28T00:01:00.000Z");
    expect(() => normalizeJitExpiry(now - 1, now)).toThrow("future");
    expect(() => normalizeJitExpiry(now + 91 * 86_400_000, now)).toThrow("90 days");
  });

  test("builds a deterministic-length safe login role", () => {
    const role = buildJitLoginRole("very-long-project-reference-that-does-not-belong-in-an-identifier", "user-id", "reader", "credential-id");
    expect(role).toMatch(/^jit_[a-f0-9]{40}$/);
    expect(role.length).toBeLessThanOrEqual(63);
  });

  test("rejects privileged or privileged-membership target roles", () => {
    const safe = {
      rolname: "authenticated",
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolbypassrls: false,
      inheritsPrivilegedRole: false,
    };
    expect(isJitTargetRoleAllowed(safe)).toBe(true);
    expect(isJitTargetRoleAllowed({ ...safe, rolname: "pg_read_all_data" })).toBe(false);
    expect(isJitTargetRoleAllowed({ ...safe, inheritsPrivilegedRole: true })).toBe(false);
  });
});
