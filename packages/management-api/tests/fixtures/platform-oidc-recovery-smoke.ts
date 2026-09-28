import assert from "node:assert/strict";
import { SQL } from "bun";

// This acceptance case requires an already migrated test tenant with an
// unavailable verifier consumer. It does not inject an outage or rotate keys.
assert.equal(process.env.SUPACLOUD_OIDC_RECOVERY_TEST, "1");
const ref = process.env.SUPACLOUD_TEST_PROJECT_REF;
assert.ok(ref && /^[a-z0-9]{10,32}$/.test(ref));
assert.ok(process.env.MASTER_TOKEN);
assert.ok(process.env.DATABASE_URL);
const location = new URL(process.env.DATABASE_URL);
const database = new SQL({
  hostname: location.hostname,
  port: Number(location.port || 5432),
  username: decodeURIComponent(location.username),
  password: decodeURIComponent(location.password),
  database: decodeURIComponent(location.pathname.slice(1)),
});

try {
  const [identity] = await database`SELECT current_database() AS name`;
  assert.equal(identity?.name, decodeURIComponent(location.pathname.slice(1)));
  const signingState = async () => {
    const [row] = await database`
      SELECT name, config #>> '{auth,oauth_server,key_id}' AS key_id,
             config #> '{auth,oauth_server,jwt_jwks}' AS public_keys,
             config #>> '{auth,oauth_server,issuer}' AS issuer
      FROM projects WHERE ref = ${ref} AND deleted_at IS NULL
    `;
    assert.ok(row?.name.startsWith("platform-app-acceptance-"));
    assert.equal(typeof row.key_id, "string");
    assert.ok(row.key_id.length > 0);
    assert.ok(Array.isArray(row.public_keys?.keys) && row.public_keys.keys.length > 0);
    assert.equal(row.issuer, `https://${ref}.api.localhost/auth/v1`);
    return { keyId: row.key_id, publicKeys: row.public_keys, issuer: row.issuer };
  };
  const before = await signingState();
  for (let attempt = 0; attempt < 2; attempt++) {
    const response: Response = await fetch(`http://127.0.0.1:9090/v1/projects/${ref}/auth/oauth-server/migrate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.MASTER_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ allow_dynamic_registration: false }),
      signal: AbortSignal.timeout(120_000),
    });
    assert.equal(response.status, 503, "unavailable verifier consumer must not yield migration success");
    const result = await response.json();
    assert.equal(result.code, "AUTH_RUNTIME_APPLY_FAILED");
    assert.equal(result.persisted, true);
    assert.equal(result.runtime_applied, false);
    assert.equal(result.authority_project_ref, ref);
    const after = await signingState();
    // Compare without including key material in assertion output.
    assert.ok(JSON.stringify(after) === JSON.stringify(before), "migration retry changed signing identity");
  }
  console.log(JSON.stringify({
    persistedPartialApply: true,
    unchangedConfigurationStillFails: true,
    signingIdentityPreserved: true,
  }));
} finally {
  await database.close();
}
