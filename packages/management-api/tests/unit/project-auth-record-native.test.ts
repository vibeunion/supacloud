// @supacloud-test-isolate
import { expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { config } from "../../src/config";
import { authOAuthServerRoutes } from "../../src/routes/auth-oauth-server";
import { findProjectAuthRecord, projectAuthRepository } from "../../src/repositories/project-auth.repository";
import { ProjectAuthContextError } from "../../src/utils/project-auth-record";
import { withNativePostgres } from "../helpers/native-postgres";

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
  "OAuth context binds real PostgreSQL identity and rejects invalid rows over native HTTP",
  async () => withNativePostgres(async (database) => {
    await database.unsafe(`
      CREATE TABLE projects (
        ref text NOT NULL, organization_id uuid, jwt_secret text NOT NULL,
        config jsonb, deleted_at timestamptz
      );
    `);
    const org = "00000000-0000-4000-8000-000000000001";
    const projectConfig = { api_domain: "api.example.com", auth: { oauth_server: { enabled: false } } };
    await database.unsafe(
      "INSERT INTO projects (ref, organization_id, jwt_secret, config) VALUES ($1, $2, $3, $4::jsonb)",
      ["native_oauth", org, "native-private-jwt-sentinel", JSON.stringify(projectConfig)],
    );
    expect(await findProjectAuthRecord("native_oauth", database)).toEqual({
      ref: "native_oauth", organization_id: org, jwt_secret: "native-private-jwt-sentinel", config: projectConfig,
    });
    expect(await findProjectAuthRecord("missing", database)).toBeNull();
    expect(await findProjectAuthRecord("native_oauth' OR TRUE --", database)).toBeNull();
    await database.unsafe(
      "INSERT INTO projects (ref, jwt_secret, config) VALUES ('nullable', 'synthetic', NULL)",
    );
    expect(await findProjectAuthRecord("nullable", database)).toMatchObject({ organization_id: null, config: {} });
    await database.unsafe(
      "INSERT INTO projects (ref, jwt_secret, config) VALUES ('legacy', 'synthetic', to_jsonb($1::text))",
      [JSON.stringify(projectConfig)],
    );
    expect(await findProjectAuthRecord("legacy", database)).toMatchObject({ config: projectConfig });

    const originalOwner = config.authRuntimeOwnerRef;
    config.authRuntimeOwnerRef = "";
    const lookup = spyOn(projectAuthRepository, "findByRef")
      .mockImplementation((ref) => findProjectAuthRecord(ref, database));
    const app = new Elysia().use(authOAuthServerRoutes);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    const getStatus = (ref: string) => fetch(new URL(`/v1/projects/${ref}/auth/oauth-server`, server.url), {
      headers: { authorization: `Bearer ${config.masterToken}` },
    });
    try {
      const valid = await getStatus("native_oauth");
      expect(valid.status).toBe(200);
      expect(valid.headers.get("cache-control")).toBe("no-store");
      const body = await valid.text();
      expect(body).not.toContain("native-private-jwt-sentinel");
      expect(JSON.parse(body)).toMatchObject({ project_ref: "native_oauth", organization_id: org });
      const missing = await getStatus("missing");
      expect(missing.status).toBe(404);
      await missing.text();

      await database.unsafe("UPDATE projects SET config = '[]'::jsonb WHERE ref = 'native_oauth'");
      const invalid = await getStatus("native_oauth");
      expect(invalid.status).toBe(503);
      expect(await invalid.json()).toEqual({
        code: "PROJECT_AUTH_CONTEXT_UNAVAILABLE", message: "Project authentication context unavailable",
      });
      await database.unsafe("UPDATE projects SET config = '{}'::jsonb, deleted_at = NOW() WHERE ref = 'native_oauth'");
      const deleted = await getStatus("native_oauth");
      expect(deleted.status).toBe(404);
      await deleted.text();

      await database.unsafe("INSERT INTO projects SELECT * FROM projects WHERE ref = 'nullable'");
      await expect(findProjectAuthRecord("nullable", database)).rejects.toBeInstanceOf(ProjectAuthContextError);
      await database.unsafe("DROP TABLE projects");
      const unavailable = await getStatus("native_oauth");
      expect(unavailable.status).toBe(503);
      expect(unavailable.headers.get("cache-control")).toBe("no-store");
      expect(await unavailable.json()).toEqual({
        code: "PROJECT_AUTH_CONTEXT_UNAVAILABLE", message: "Project authentication context unavailable",
      });
    } finally {
      await server.stop(true);
      lookup.mockRestore();
      config.authRuntimeOwnerRef = originalOwner;
    }
  }),
  30_000,
);
