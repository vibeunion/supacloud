import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { SignJWT } from "jose";
import { config } from "../../src/config";
import { sql, resolveSlotName } from "../../src/db";
import { RealtimeService } from "../../src/services/realtime.service";
import { buildRealtimeTenantPayload } from "../../src/services/realtime-tenant-payload";
import { resolveProjectJwtVerificationMaterial } from "../../src/utils/project-jwt";

assert.equal(process.env.SUPACLOUD_REALTIME_TEST, "1");
const ref = process.env.SUPACLOUD_TEST_PROJECT_REF;
assert.ok(ref && /^[a-z0-9]{10,32}$/.test(ref));
assert.equal(new URL(config.realtimeAdminUrl).hostname, "127.0.0.1");
const evidence: Record<string, boolean | number> = {};
try {
  const [project] = await sql`
    SELECT name, anon_key, db_name, db_password, jwt_secret, config FROM projects
    WHERE ref = ${ref} AND deleted_at IS NULL
  `;
  assert.ok(project?.name.startsWith("platform-app-acceptance-"));
  assert.ok(project.anon_key && project.db_name && project.jwt_secret);
  const service = new RealtimeService();
  const tenantConfig = {
    projectRef: ref, dbName: project.db_name, dbPassword: project.db_password,
    jwtSecret: project.jwt_secret, projectConfig: project.config,
  };
  const adminJwt = await new SignJWT({ role: "supabase_admin" })
    .setProtectedHeader({ alg: "HS256" }).setIssuer("supabase")
    .setIssuedAt().setExpirationTime("5m")
    .sign(new TextEncoder().encode(config.jwtSecret));
  const readTenant = () => fetch(`${config.realtimeAdminUrl}/api/tenants/${ref}`, {
    headers: { authorization: `Bearer ${adminJwt}` }, signal: AbortSignal.timeout(15_000),
    proxy: undefined,
  });
  const before = await readTenant();
  assert.ok(before.ok || before.status === 404, `tenant preflight HTTP ${before.status}`);
  // Do not replay an ambiguous write. A later run reads the tenant first.
  process.env.REALTIME_REGISTER_MAX_ATTEMPTS = "1";
  const options = { signal: AbortSignal.timeout(15_000) };
  assert.equal(await (before.ok ? service.updateTenant(tenantConfig, options) : service.registerTenant(tenantConfig, options)),
    true, "tenant registration/update did not confirm success");
  const response = await readTenant();
  assert.equal(response.status, 200, "tenant readback failed");
  const body = await response.json();
  const tenant = body.data ?? body;
  assert.equal(tenant.external_id, ref);
  const material = resolveProjectJwtVerificationMaterial(project.config, project.jwt_secret);
  const expected = buildRealtimeTenantPayload({
    projectRef: ref, dbHost: config.pgHost, dbPort: String(config.pgPort),
    dbName: project.db_name, adminDbPassword: config.pgPassword,
    jwtSecret: project.jwt_secret, jwtJwks: material.jwtJwks,
    slotName: resolveSlotName(ref),
  }).tenant;
  const extension = tenant.extensions.find((item: { type: string }) => item.type === "postgres_cdc_rls");
  assert.ok(extension);
  const encryptionKey = Buffer.from(process.env.REALTIME_DB_ENC_KEY ?? "");
  assert.equal(encryptionKey.length, 16, "acceptance runtime encryption key missing");
  for (const key of ["db_host", "db_port", "db_name", "db_user", "slot_name"] as const) {
    assert.equal(typeof extension.settings[key], "string", `${key} missing`);
    const expectedValue = expected.extensions[0]!.settings[key];
    let actual = extension.settings[key];
    if (actual !== expectedValue) {
      // The pinned acceptance runtime uses its legacy AES-128-ECB format.
      // Keep decrypted values in memory; do not include them in diagnostics.
      const decipher = createDecipheriv("aes-128-ecb", encryptionKey, null);
      actual = Buffer.concat([decipher.update(Buffer.from(actual, "base64")), decipher.final()]).toString();
    }
    assert.ok(actual === expectedValue, `${key} readback mismatch`);
  }
  assert.equal("db_password" in extension.settings, false, "Realtime leaked database password");
  evidence[before.ok ? "tenantUpdated" : "tenantRegistered"] = true;
  evidence.tenantConfigurationReadback = true;
  // The public admin response omits verification keys. This owned acceptance
  // platform stores Realtime metadata in the same PostgreSQL database.
  const [stored] = await sql`SELECT jwt_jwks FROM _realtime.tenants WHERE external_id = ${ref}`;
  assert.ok(expected.jwt_jwks && expected.jwt_jwks.keys.length > 0, "OIDC keys missing");
  assert.deepEqual(stored?.jwt_jwks, expected.jwt_jwks, "persisted OIDC keys differ");
  evidence.oidcVerificationKeysReadback = true;
  evidence.verificationKeyCount = expected.jwt_jwks.keys.length;
  console.log(JSON.stringify({ status: "PASS", scope: "realtime-tenant-apply-readback", evidence }));
} finally {
  await sql.close({ timeout: 1 });
}
