// @supacloud-test-isolate
import { expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { config } from "../../src/config";
import * as dbModule from "../../src/db";
import { findStorageRoutingProject, listStorageRoutingProjects } from "../../src/repositories/storage-routing.repository";
import { storageCompatInternals, storageCompatRoutes } from "../../src/routes/storage-compat";
import { StorageRLS } from "../../src/services/storage-rls";
import { StorageRoutingUnavailableError } from "../../src/utils/storage-routing-record";
import { withNativePostgres } from "../helpers/native-postgres";

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
  "native storage routing validates project receipts and rejects unavailable or ambiguous HTTP bindings",
  async () => withNativePostgres(async (database) => {
    await database`
      CREATE TABLE projects (ref text, status text, config jsonb, deleted_at timestamptz)
    `;
    const originalBaseDomain = config.baseDomain;
    config.baseDomain = "example.com";
    const lookup = spyOn(dbModule, "sql").mockImplementation(database);
    const apiKey = spyOn(storageCompatInternals, "resolveProjectRefFromApiKey").mockResolvedValue("");
    const buckets = spyOn(StorageRLS, "listLogicalBuckets").mockResolvedValue([]);
    const app = new Elysia({ prefix: "/storage/v1" }).use(storageCompatRoutes);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    async function route(headers: Record<string, string>) {
      buckets.mockClear();
      const response = await fetch(new URL("/storage/v1/bucket", server.url), { headers });
      const body: unknown = await response.json();
      return { status: response.status, calls: buckets.mock.calls.length, body };
    }
    try {
      for (const [ref, status] of [
        ["active_project", "ACTIVE"], ["creating_project", "creating"],
        ["paused_project", "paused"], ["deleted_project", "active"],
      ] satisfies Array<[string, string]>) {
        await database`INSERT INTO projects (ref, status, config) VALUES (${ref}, ${status}, NULL)`;
      }
      await database`UPDATE projects SET deleted_at = NOW() WHERE ref = 'deleted_project'`;
      const legacyConfig = { custom_domain: "custom.external.test" };
      await database.unsafe(
        "INSERT INTO projects (ref, status, config) VALUES ('legacy_json', 'active', to_jsonb($1::text))",
        [JSON.stringify(legacyConfig)],
      );
      await database.unsafe(
        "INSERT INTO projects (ref, status, config) VALUES ('legacy_domain', 'active', to_jsonb($1::text))",
        ["legacy.external.test"],
      );
      expect(await findStorageRoutingProject("active_project", database))
        .toEqual({ ref: "active_project", config: {} });
      expect(await findStorageRoutingProject("creating_project", database))
        .toEqual({ ref: "creating_project", config: {} });
      expect(await findStorageRoutingProject("legacy_json", database))
        .toEqual({ ref: "legacy_json", config: legacyConfig });
      expect(await findStorageRoutingProject("legacy_domain", database))
        .toEqual({ ref: "legacy_domain", config: { custom_domain: "legacy.external.test" } });
      expect((await listStorageRoutingProjects(database)).map(project => project.ref).sort())
        .toEqual(["active_project", "creating_project", "legacy_domain", "legacy_json"]);

      for (const ref of ["missing", "paused_project", "deleted_project"]) {
        expect(await findStorageRoutingProject(ref, database)).toBeNull();
        expect(await route({ host: `${ref}.api.example.com`, "x-project-ref": ref }))
          .toMatchObject({ status: 400, calls: 0 });
      }
      await expect(findStorageRoutingProject("active_project' OR TRUE --", database))
        .rejects.toBeInstanceOf(StorageRoutingUnavailableError);
      for (const [ref, host] of [
        ["active_project", "active_project.api.example.com"],
        ["creating_project", "127.0.0.1:9090"],
        ["creating_project", "[::1]:9090"],
        ["legacy_json", "custom.external.test"],
        ["legacy_domain", "legacy.external.test"],
      ] satisfies Array<[string, string]>) {
        expect(await route({ host, "x-project-ref": ref }))
          .toEqual({ status: 200, calls: 1, body: [] });
      }

      apiKey.mockResolvedValue("active_project");
      expect(await route({ host: "active_project.api.example.com", apikey: "fixture-api-key" }))
        .toEqual({ status: 200, calls: 1, body: [] });
      expect(await route({ host: "direct.external.test", apikey: "fixture-api-key" }))
        .toEqual({ status: 200, calls: 1, body: [] });
      expect(await route({ host: "creating_project.api.example.com", apikey: "fixture-api-key" }))
        .toMatchObject({ status: 400, calls: 0 });
      expect(await route({ host: "missing.api.example.com", apikey: "fixture-api-key" }))
        .toMatchObject({ status: 400, calls: 0 });
      expect(await route({
        host: "active_project.api.example.com", apikey: "fixture-api-key", "x-project-ref": "creating_project",
      })).toMatchObject({ status: 400, calls: 0 });

      await database`INSERT INTO projects SELECT * FROM projects WHERE ref = 'active_project'`;
      await expect(findStorageRoutingProject("active_project", database))
        .rejects.toBeInstanceOf(StorageRoutingUnavailableError);
      await expect(listStorageRoutingProjects(database)).rejects.toBeInstanceOf(StorageRoutingUnavailableError);
      expect(await route({ host: "active_project.api.example.com", apikey: "fixture-api-key" }))
        .toMatchObject({ status: 400, calls: 0 });
      await database`DELETE FROM projects WHERE ref = 'active_project'`;
      await database.unsafe(`
        INSERT INTO projects (ref, status, config) VALUES
          ('active_project', 'active', '{"api_domain":"shared.external.test"}'::jsonb),
          ('clashing_project', 'active', '{"api_domain":"shared.external.test"}'::jsonb)
      `);
      expect(await route({ host: "shared.external.test", apikey: "fixture-api-key" }))
        .toMatchObject({ status: 400, calls: 0 });
      apiKey.mockResolvedValue("");
      expect(await route({ host: "shared.external.test", "x-project-ref": "active_project" }))
        .toMatchObject({ status: 400, calls: 0 });
      await database`DELETE FROM projects WHERE ref = 'clashing_project'`;

      for (const malformed of ["[]", "42", '{"api_domain":42}', '"{broken json"']) {
        await database.unsafe("UPDATE projects SET config = $1::jsonb WHERE ref = 'active_project'", [malformed]);
        await expect(findStorageRoutingProject("active_project", database))
          .rejects.toBeInstanceOf(StorageRoutingUnavailableError);
        expect(await route({ host: "active_project.api.example.com", "x-project-ref": "active_project" }))
          .toMatchObject({ status: 400, calls: 0 });
      }

      apiKey.mockResolvedValue("active_project");
      await database.unsafe("DROP TABLE projects");
      expect(await route({ host: "active_project.api.example.com", apikey: "fixture-api-key" }))
        .toEqual({
          status: 400, calls: 0,
          body: { statusCode: "400", error: "Bad Request", message: "Missing or invalid project reference" },
        });
      await expect(findStorageRoutingProject("active_project", database))
        .rejects.toThrow("Storage project routing unavailable");
    } finally {
      await server.stop(true);
      lookup.mockRestore();
      apiKey.mockRestore();
      buckets.mockRestore();
      config.baseDomain = originalBaseDomain;
    }
  }),
  30_000,
);
