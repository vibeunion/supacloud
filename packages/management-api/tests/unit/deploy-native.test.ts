// @supacloud-test-isolate
import { expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readlink, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withNativePostgres } from "../helpers/native-postgres";
import { InvalidDeploymentRecordError, type DeployRequest } from "../../src/utils/deploy-contract";

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
  "native deployment history validates JSONB and rollback inputs around temporary static releases",
  async () => withNativePostgres(async database => {
    const directory = await mkdtemp(join(tmpdir(), "supacloud-deploy-native-"));
    try {
      const originalDb = await import("../../src/db");
      mock.module("../../src/db", () => ({ ...originalDb, sql: database }));
      const { DeployServiceClass } = await import("../../src/services/deploy.service");
      const service = new DeployServiceClass();
      await database.unsafe(`
        CREATE TABLE deployment_history (
          id text PRIMARY KEY, app text NOT NULL, tenant text NOT NULL, version text NOT NULL,
          status text NOT NULL, deployed_at timestamptz NOT NULL, triggered_by text NOT NULL, config jsonb NOT NULL
        );
      `);
      const source = join(directory, "source");
      await mkdir(join(source, "dist"), { recursive: true });
      await Bun.write(join(source, "dist", "index.html"), "<h1>Synthetic fixture</h1>");
      const archive = join(directory, "artifact.tar");
      const tar = Bun.spawn(["tar", "-cf", archive, "-C", source, "dist"], { stdout: "pipe", stderr: "pipe" });
      const [tarCode, tarError] = await Promise.all([tar.exited, new Response(tar.stderr).text()]);
      if (tarCode !== 0) throw new Error(`Could not build synthetic archive: ${tarError}`);
      const request: DeployRequest = {
        app: "fixture", tenant: "fixture-tenant",
        artifact: Buffer.from(await Bun.file(archive).arrayBuffer()).toString("base64"),
        config: {
          app: "fixture", tenant: "fixture-tenant",
          static: [
            { name: "one", source: "dist", target: join(directory, "site.[1]+") },
            { name: "two", source: "dist", target: join(directory, "second") },
          ],
        },
      };
      const first = await service.deploy(request);
      expect(first.success).toBe(true);
      expect(first.rollbackCommand).toBe("");
      expect(await Bun.file(join(directory, "site.[1]+", "index.html")).text()).toBe("<h1>Synthetic fixture</h1>");
      expect(await readlink(join(directory, "site.[1]+"))).toEndWith(first.versions.current);
      expect(await readlink(join(directory, "second"))).toEndWith(first.versions.current);
      const encoding: unknown = await database`SELECT jsonb_typeof(config) AS kind FROM deployment_history`;
      expect(encoding).toEqual([{ kind: "object" }]);
      expect((await service.getHistory("fixture"))[0]?.config).toEqual(request.config);
      expect((await service.getVersions("fixture"))[0]?.version).toBe(first.versions.current);
      const second = await service.deploy(request);
      expect(second.success).toBe(true);
      expect(second.versions.current).not.toBe(first.versions.current);
      expect(second.versions.previous).toBe(first.versions.current);
      expect(second.rollbackCommand).toContain(`--version ${first.versions.current}`);
      expect(await Bun.file(join(directory, `site.[1]+_${first.versions.current}`, "index.html")).exists()).toBe(true);

      await database`UPDATE deployment_history SET version = '../outside' WHERE id = ${first.deploymentId}`;
      await expect(service.getHistory("fixture")).rejects.toBeInstanceOf(InvalidDeploymentRecordError);
      await expect(service.getVersions("fixture")).rejects.toBeInstanceOf(InvalidDeploymentRecordError);
      const beforeRollback = await readlink(join(directory, "site.[1]+"));
      expect((await service.rollback("fixture")).success).toBe(false);
      expect(await readlink(join(directory, "site.[1]+"))).toBe(beforeRollback);
      await database`UPDATE deployment_history SET version = ${first.versions.current} WHERE id = ${first.deploymentId}`;
      await database.unsafe(`
        CREATE FUNCTION corrupt_deployment_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN NEW.config := jsonb_set(NEW.config, '{tenant}', '"other"'); RETURN NEW; END $$;
        CREATE TRIGGER corrupt_deployment_receipt BEFORE INSERT ON deployment_history
          FOR EACH ROW EXECUTE FUNCTION corrupt_deployment_receipt();
      `);
      await expect(service.deploy(request)).rejects.toBeInstanceOf(InvalidDeploymentRecordError);
      const count: unknown = await database`SELECT COUNT(*)::integer AS count FROM deployment_history`;
      expect(count).toEqual([{ count: 2 }]);
      // Two destinations per attempt: the invalid metadata receipt did not replay file activation.
      expect((await readdir(directory)).filter(name => /^site\.\[1\]\+_/.test(name))).toHaveLength(3);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }),
  40_000,
);
