import { describe, expect, test } from "bun:test";
import {
  assertJitCredentialCapacity,
  assertJitIssuanceRate,
  buildJitLoginRole,
  isJitTargetRoleAllowed,
  jitRuleCoversCredential,
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
    expect(normalizeJitExpiry(now + 300_000, now).toISOString()).toBe("2026-07-28T00:05:00.000Z");
    expect(() => normalizeJitExpiry(now - 1, now)).toThrow("future");
    expect(() => normalizeJitExpiry(now + 60_000, now)).toThrow("at least 5 minutes");
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

  test("bounds active credentials even when no gateway port is required", () => {
    expect(() => assertJitCredentialCapacity(4, 99)).not.toThrow();
    expect(() => assertJitCredentialCapacity(5, 1)).toThrow("at most 5");
    expect(() => assertJitCredentialCapacity(1, 100)).toThrow("at most 100");
  });

  test("rate-limits repeated issuance after short-lived credentials expire", () => {
    expect(() => assertJitIssuanceRate(9, 99)).not.toThrow();
    expect(() => assertJitIssuanceRate(10, 1)).toThrow("at most 10");
    expect(() => assertJitIssuanceRate(1, 100)).toThrow("at most 100");
  });

  test("revokes credentials when a rule narrows networks or expiry", () => {
    const original = {
      expiresAt: new Date("2026-07-29T00:00:00.000Z"),
      allowedNetworks: { ipv4: ["10.0.0.0/8"], ipv6: [] },
    };
    expect(jitRuleCoversCredential(original, { ...original })).toBe(true);
    expect(jitRuleCoversCredential(original, {
      ...original,
      allowedNetworks: { ipv4: ["10.0.0.0/24"], ipv6: [] },
    })).toBe(false);
    expect(jitRuleCoversCredential(original, {
      ...original,
      expiresAt: new Date("2026-07-28T12:00:00.000Z"),
    })).toBe(false);
    expect(jitRuleCoversCredential(original, null)).toBe(false);
  });
});
