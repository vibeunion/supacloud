import { sql } from "./packages/management-api/src/db/index.ts";

async function main() {
  const input = {
    ref: "test_ref",
    name: "test_name",
    db_name: "test_db",
    db_user: "test_user",
    db_password: "test_password",
    jwt_secret: "test_jwt",
    anon_key: "anon",
    service_role_key: "service",
    s3_bucket: "bucket",
    s3_access_key: "key",
    s3_secret_key: "secret",
    region: "local",
    config: {}
  };

  try {
    const [project] = await sql`
      INSERT INTO projects (
        ref, name, db_name, db_user, db_password,
        jwt_secret, anon_key, service_role_key,
        s3_bucket, s3_access_key, s3_secret_key,
        region, config
      ) VALUES (
        ${input.ref},
        ${input.name},
        ${input.db_name},
        ${input.db_user},
        ${input.db_password},
        ${input.jwt_secret},
        ${input.anon_key},
        ${input.service_role_key},
        ${input.s3_bucket},
        ${input.s3_access_key || null},
        ${input.s3_secret_key || null},
        ${input.region || "local"},
        ${input.config ? JSON.stringify(input.config) : sql`'{}'::jsonb`}::jsonb
      )
      RETURNING *
    `;
    console.log("Returned:", project);
  } catch (error) {
    console.error("Caught ERROR:", error);
  }
}
main().then(() => process.exit(0));
