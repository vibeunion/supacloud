import { describe, expect, test } from "bun:test";
import {
  renderTenantHbaPairingDropSql,
  renderTenantHbaPairingSql,
} from "../../src/services/tenant-hba-pairing";

describe("tenant HBA pairing SQL", () => {
  test("grants samerole membership without inheriting or exposing a password", () => {
    const sql = renderTenantHbaPairingSql("supa_proj-1", "role_proj", "authenticator_proj");
    expect(sql).toContain('CREATE ROLE "supa_proj-1" NOLOGIN NOINHERIT');
    expect(sql).toContain('GRANT "supa_proj-1" TO "authenticator_proj" WITH INHERIT FALSE, SET FALSE');
    expect(sql).toContain('GRANT "supa_proj-1" TO "role_proj" WITH INHERIT FALSE, SET FALSE');
    expect(sql).not.toContain("PASSWORD");
    expect(sql).not.toContain("cluster-secret");
  });

  test("drops the anchor role after revoking both tenant logins", () => {
    const sql = renderTenantHbaPairingDropSql("supa_proj", "role_proj", "authenticator_proj");
    expect(sql.indexOf("REVOKE")).toBeLessThan(sql.indexOf("DROP ROLE"));
    expect(sql).toContain("authenticator_proj");
    expect(sql).toContain("role_proj");
    expect(sql).not.toContain("PASSWORD");
  });

  test("rejects identifiers that cannot be quoted safely", () => {
    expect(() => renderTenantHbaPairingSql("supa_proj", "role proj", "authenticator_proj")).toThrow(/Invalid identifier/);
  });
});
