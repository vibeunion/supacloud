import { describe, expect, test } from "bun:test";
import { isTransientAuditFailure } from "./audit_dependencies";

describe("dependency audit retry classification", () => {
  test("retries advisory service outages and network failures", () => {
    expect(isTransientAuditFailure("error: POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk - 503")).toBe(true);
    expect(isTransientAuditFailure("fetch failed: ECONNRESET")).toBe(true);
    expect(isTransientAuditFailure("network timeout while contacting registry")).toBe(true);
  });

  test("does not retry an actual audit finding", () => {
    expect(isTransientAuditFailure("1 high severity vulnerability found")).toBe(false);
  });
});
