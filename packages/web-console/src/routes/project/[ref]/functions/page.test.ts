import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./+page.svelte", import.meta.url), "utf8");

describe("edge function JWT toggle", () => {
  test("renders the confirmed server state without mutating query records", () => {
    expect(source).toContain("requireVerifyJwtResponse(await res.json())");
    expect(source).toContain("functions = functions.map");
    expect(source).toContain("selectedFunction = { ...selectedFunction, verify_jwt: verifyJwt }");
    expect(source).not.toContain("fn.verify_jwt =");
  });

  test("prevents repeated updates while a toggle request is pending", () => {
    expect(source).toContain("disabled={verifyJwtMutation.isPending}");
    expect(source).toContain("aria-busy={jwtUpdatingSlug === fn.slug}");
  });

  test("localizes known statuses while retaining their raw technical value", () => {
    expect(source).toContain('status === "ACTIVE" ? $t("Functions.status_active") : status');
    expect(source).toContain("title={fn.status}");
    expect(source).toContain('$t("Functions.active_version"');
    expect(source).toContain('$t("Functions.version")');
    expect(source).toContain('$t("Functions.endpoint")');
    expect(source).toContain('$t("Functions.last_deploy")');
  });

  test("binds create and version activation requests to the observed active version", () => {
    expect(source).toContain('expected_active_version: "absent"');
    expect(source).toContain("activeVersionForSlug(slug)");
    expect(source).toContain("activeVersion < 0");
    expect(source).toContain("expected_active_version: expectedActiveVersion");
    expect(source).toContain('versionRecord.version === "0"');
    expect(source).not.toContain("fn.version || 1");
    expect(source).not.toContain("selectedFunction.version || 1");
  });

  test("keeps legacy version zero out of immutable source detail requests", () => {
    expect(source).toContain("requestImmutableFunctionVersion(apiClient");
    expect(source).toContain("if (res === null)");
    expect(source.match(/disabled=\{versionRecord\.version === "0"/g)).toHaveLength(2);
    expect(source).toContain("兼容版本 v0 仅作为并发控制标记，不提供不可变版本详情");
  });
});
