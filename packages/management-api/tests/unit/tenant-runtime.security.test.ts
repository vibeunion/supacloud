import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../src/services/tenant-runtime.service.ts", import.meta.url), "utf8");
const configSource = readFileSync(new URL("../../src/services/tenant-runtime-config.ts", import.meta.url), "utf8");

describe("TenantRuntimeService secret handling", () => {
  test("never puts a password-bearing database URI in psql argv", () => {
    expect(source).not.toMatch(/psql\s+\$\{dbUrl\}/);
    expect(source).not.toMatch(/\$`psql\s+\$\{[^}]*Url\}/);
    expect(source).not.toContain("postgres://postgres:${config.pgPassword}");
    expect(source).toContain("buildTenantPsqlInvocation");
    expect(configSource).toContain("PGPASSWORD");
  });

  test("writes tenant runtime files as tenant-owned 0600 files under a 0700 private directory", () => {
    expect(source).toContain("User=supacloud-%i");
    expect(source).toContain("Group=supacloud-%i");
    expect(source).toContain("mode: 0o600");
    expect(source).toContain("mode: 0o700");
    expect(source).toContain("chown");
    expect(source).toContain("rename");
  });

  test("separates the pgredis owner connection from the Edge Function environment", () => {
    const pgrstEnv = source.match(
      /const\s+pgrstEnv\s*=\s*\[[\s\S]*?\]\s*\.filter\s*\(\s*Boolean\s*\)\s*\.join\s*\(\s*["']\\n["']\s*\)\s*;/,
    );
    const pgredisUrlRenderCalls = source.match(
      /renderSystemdEnvLine\s*\(\s*["']PGREDIS_DATABASE_URL["']/g,
    );

    expect(pgredisUrlRenderCalls).toHaveLength(1);
    expect(source).toMatch(
      /this\.writeTenantSecretFile\s*\(\s*path\.join\s*\(\s*this\.PGREDIS_CONFIG_DIR\s*,\s*`\$\{ref\}_pgredis\.env`\s*\)\s*,\s*renderSystemdEnvLine\s*\(\s*["']PGREDIS_DATABASE_URL["']\s*,[\s\S]*?\)\s*,\s*undefined\s*,\s*this\.PGREDIS_CONFIG_OWNER\s*\|\|\s*undefined\s*,?\s*\)/,
    );
    expect(source).toContain("user: resolveRoleName(ref)");
    expect(source).toContain("owner?: string");
    expect(source).toContain("if (owner) await this.chownPath(tempPath, owner)");
    expect(pgrstEnv).toBeDefined();
    expect(pgrstEnv?.[0]).not.toContain("PGREDIS_DATABASE_URL");
  });

  test("missing binary guidance points only to the pinned verified runtime installer", () => {
    expect(source).not.toContain("releases/latest");
    expect(source).not.toContain("Install it manually: curl");
    expect(source).toContain("tenant_runtime.sh");
    expect(source).toContain("ensure_postgrest");
    expect(source).toContain("ensure_gotrue");
  });

  test("injects third-party issuer keys into the tenant PostgREST verifier", () => {
    expect(source).toContain("resolveProjectJwtVerificationMaterial(projectConfig, project.jwt_secret)");
    expect(source).toContain("jwt-aud =");
    expect(source).toContain("client_id_claim");
    expect(source).toContain("third-party JWT claims rejected");
  });

  test("shared auth keeps owner private signing material out and rejects non-user owner roles", () => {
    expect(source).toContain("buildSharedProjectJwtVerificationMaterial");
    expect(source).toContain('renderSystemdEnvLine("SUPACLOUD_AUTH_ISSUER", creds.localJwtIssuer)');
    expect(source).toContain('sharedAuthRuntime ? "" : renderSystemdEnvLine("JWT_SECRET"');
    expect(source).toContain('sharedAuthRuntime ? "" : jwtKeysEnv');
    expect(source).toContain("jwtAudience: isSharedAuthRuntime(ref)");
    expect(source).toContain("SupAuth owner tokens may only use the authenticated role");
    expect(source).toContain("Dependent legacy user sessions are disabled while SupAuth is active");
  });
});
