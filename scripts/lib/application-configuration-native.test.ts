import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStarterPostgres, type StarterPostgres } from "./starter-postgres";
import { ensureApplicationConfigurationSchema } from "../../packages/management-api/src/db/application-configuration-schema";
import { ApplicationConfigurations } from "../../packages/management-api/src/services/application-configuration";
import { encryptSecretWithKey, decryptSecretWithKey } from "../../packages/management-api/src/utils/secret-crypto";
import { createApplicationRoutes } from "../../packages/management-api/src/routes/applications";
import { runtimeInput } from "../../packages/management-api/tests/helpers/application-runtime";
import { HttpTransport } from "../../packages/cli/src/shared/transports/http";
import { registerApplicationTools } from "../../packages/cli/src/shared/tools/application-tools";
import type { ReleaseControlToolResponse } from "../../packages/cli/src/shared/tools/release-control-response";

const postgresBin = process.env.SUPACLOUD_STARTER_POSTGRES_BIN;
let postgres: StarterPostgres | undefined;
let database: SQL;
let configurations: ApplicationConfigurations;
const key = randomBytes(32).toString("hex");
const crypto = { encrypt: (value: string) => encryptSecretWithKey(value, key),
  decrypt: (value: string) => decryptSecretWithKey(value, key) };
const scope = (environmentId: string) => ({ projectRef: "demo", applicationId: "reviews", environmentId });
function write(expected: string | null = null) {
  return {
    configuration_id: randomUUID(), expected_configuration_id: expected,
    configuration: { bun_version: "1.4.2", targets: [
      { name: "api", kind: "http", hosts: ["reviews.example.test"], environment: { APP_SETTING: "private-config-fixture" } },
      { name: "jobs", kind: "worker", hosts: [], environment: {} },
    ] },
  };
}
beforeAll(async () => {
  if (!postgresBin) return;
  postgres = await startStarterPostgres(postgresBin);
  database = await postgres.withConnection(async url => new SQL({ url, max: 6 }));
  await database`CREATE TABLE projects(ref varchar(20) PRIMARY KEY)`;
  await database`INSERT INTO projects VALUES ('demo'), ('other')`;
  await database.begin(ensureApplicationConfigurationSchema);
  await database.begin(ensureApplicationConfigurationSchema);
  configurations = new ApplicationConfigurations(database, crypto);
}, 60_000);
afterAll(async () => {
  try { await database?.close({ timeout: 1 }); }
  finally { await postgres?.close(); }
});

test.skipIf(!postgresBin)("immutable revisions survive PostgreSQL restart and old retries cannot reset the head", async () => {
  const identity = scope("restart"), first = write();
  const saved = await configurations.put(identity, first);
  expect(saved.targets[0]!.environment_names).toEqual(["APP_SETTING"]);
  expect(JSON.stringify(saved)).not.toContain("private-config-fixture");
  const [stored] = await database`SELECT * FROM application_configuration_revisions WHERE environment_id = 'restart'`;
  expect(JSON.stringify(stored)).not.toContain("private-config-fixture");
  expect(stored.encrypted_configuration).not.toContain("APP_SETTING");
  const next = write(first.configuration_id);
  next.configuration.targets[0]!.environment.APP_SETTING = "new-config-fixture";
  await configurations.put(identity, next);
  await database.close({ timeout: 1 });
  await postgres!.restart();
  database = await postgres!.withConnection(async url => new SQL({ url, max: 6 }));
  configurations = new ApplicationConfigurations(database, crypto);
  expect(await configurations.put(identity, first)).toEqual(saved);
  expect((await configurations.read(identity))?.configuration_id).toBe(next.configuration_id);
  expect((await configurations.resolve(identity, first.configuration_id, runtimeInput().release)).environment.api)
    .toEqual({ APP_SETTING: "private-config-fixture" });
  expect((await configurations.resolve(identity, next.configuration_id, runtimeInput().release)).environment.api)
    .toEqual({ APP_SETTING: "new-config-fixture" });
});

test.skipIf(!postgresBin)("native concurrent compare-and-swap updates publish exactly one revision", async () => {
  const identity = scope("concurrency"), first = write();
  const identical = await Promise.all([configurations.put(identity, first), configurations.put(identity, first)]);
  expect(identical[0]).toEqual(identical[1]);
  const candidates = [write(first.configuration_id), write(first.configuration_id)];
  const results = await Promise.allSettled(candidates.map(input => configurations.put(identity, input)));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
  expect(rejected.reason.code).toBe("APPLICATION_CONFIGURATION_REVISION_CONFLICT");
  const rows = await database`SELECT configuration_id FROM application_configuration_revisions WHERE environment_id = 'concurrency'`;
  expect(rows).toHaveLength(2);
  expect(candidates.some(input => input.configuration_id === results
    .find((result): result is PromiseFulfilledResult<Awaited<ReturnType<ApplicationConfigurations["put"]>>> =>
      result.status === "fulfilled")!.value.configuration_id)).toBe(true);
});

test.skipIf(!postgresBin)("revision IDs bind their entire request and reads do not create missing scopes", async () => {
  const identity = scope("binding"), input = write();
  await configurations.put(identity, input);
  const changed = structuredClone(input);
  changed.configuration.targets[0]!.environment.APP_SETTING = "changed";
  await expect(configurations.put(identity, changed)).rejects.toThrow("ID_CONFLICT");
  changed.configuration = input.configuration;
  changed.expected_configuration_id = randomUUID();
  await expect(configurations.put(identity, changed)).rejects.toThrow("ID_CONFLICT");
  expect(await configurations.read(scope("absent"))).toBeNull();
  expect(await configurations.read({ ...identity, projectRef: "other" }, input.configuration_id)).toBeNull();
  expect(await configurations.read({ ...identity, applicationId: "different" }, input.configuration_id)).toBeNull();
  await expect(configurations.resolve(identity, undefined as unknown as string, runtimeInput().release))
    .rejects.toThrow("INVALID_ID");
  await expect(configurations.resolve(scope("absent"), input.configuration_id, runtimeInput().release))
    .rejects.toThrow("NOT_FOUND");
});

test.skipIf(!postgresBin)("encryption failure leaves no revision or head and target mismatches cannot deploy", async () => {
  const identity = scope("failure"), input = write();
  const broken = new ApplicationConfigurations(database, { ...crypto, encrypt: () => { throw new Error("encryption unavailable"); } });
  await expect(broken.put(identity, input)).rejects.toThrow("encryption unavailable");
  expect(await configurations.read(identity)).toBeNull();
  const rows = await database`SELECT * FROM application_configuration_revisions WHERE environment_id = 'failure'`;
  expect(rows).toHaveLength(0);
  await configurations.put(identity, input);
  const release = runtimeInput().release;
  release.targets[0]!.name = "different";
  await expect(configurations.resolve(identity, input.configuration_id, release)).rejects.toThrow("TARGET_MISMATCH");
  const crossProject = runtimeInput().release;
  crossProject.project_ref = "other";
  await expect(configurations.resolve(identity, input.configuration_id, crossProject)).rejects.toThrow("TARGET_MISMATCH");
  await database`
    UPDATE application_configuration_revisions SET public_configuration = '{"bun_version":"9.9.9","targets":[]}'::jsonb
    WHERE environment_id = 'failure'
  `;
  await expect(configurations.resolve(identity, input.configuration_id, runtimeInput().release)).rejects.toThrow("CORRUPT");
});

test.skipIf(!postgresBin)("configuration routes enforce access and preserve revisions without disclosing values", async () => {
  let accesses = 0;
  const app = createApplicationRoutes({
    configurations, projectExists: async () => true,
    authorize: async request => {
      accesses++;
      return request.headers.get("authorization") === "Bearer local-configuration-test"
        ? undefined : { status: 401, body: { error: "Unauthorized" } };
    },
  });
  const url = "http://localhost/v1/projects/demo/applications/reviews/environments/routes/configuration";
  const input = write();
  const headers = { authorization: "Bearer local-configuration-test", "content-type": "application/json" };
  const request = (body: unknown = input) => new Request(url, { method: "PUT", headers, body: JSON.stringify(body) });
  expect((await app.handle(new Request(url))).status).toBe(401);
  expect((await app.handle(new Request(url, { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify(input) }))).status).toBe(401);
  expect(await configurations.read(scope("routes"))).toBeNull();
  const created = await app.handle(request());
  expect(created.status).toBe(200);
  expect(await created.text()).not.toContain("private-config-fixture");
  const current = await app.handle(new Request(url, { headers }));
  expect((await current.json()).configuration.configuration_id).toBe(input.configuration_id);
  const revision = await app.handle(new Request(`${url}s/${input.configuration_id}`, { headers }));
  expect(revision.status).toBe(200);
  expect((await revision.json()).configuration.configuration_id).toBe(input.configuration_id);
  expect((await app.handle(request(write()))).status).toBe(409);
  const invalid = await app.handle(request({ ...input, configuration_id: "private-config-fixture" }));
  expect(invalid.status).toBe(422);
  expect(await invalid.text()).not.toContain("private-config-fixture");
  const malformed = await app.handle(new Request(url, { method: "PUT", headers, body: '{"private-config-fixture":' }));
  expect(malformed.status).toBe(400);
  expect(await malformed.text()).not.toContain("private-config-fixture");
  expect(accesses).toBeGreaterThanOrEqual(6);
});

test.skipIf(!postgresBin)("CLI saves and reads actual PostgreSQL configuration revisions over HTTP", async () => {
  const app = createApplicationRoutes({
    configurations, projectExists: async () => true,
    authorize: async request => request.headers.get("authorization") === "Bearer local-configuration-test"
      ? undefined : { status: 401, body: { error: "Unauthorized" } },
  });
  const root = await mkdtemp(join(tmpdir(), "application-config-cli-"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  try {
    let callback: ((args: Record<string, unknown>) => Promise<ReleaseControlToolResponse>) | undefined;
    registerApplicationTools({
      tool(_name, _description, _schema, handler) { callback = handler; },
    }, new HttpTransport({ baseUrl: server.url.toString(), token: "local-configuration-test" }));
    if (!callback) throw new Error("Applications CLI not registered");
    const first = write(), next = write(first.configuration_id);
    const path = join(root, "configuration.json");
    const common = { ref: "demo", id: "reviews", environment_id: "cli" };
    for (const input of [first, next, first]) {
      await writeFile(path, JSON.stringify(input));
      const response = await callback({ ...common, action: "put_configuration", configuration_path: path });
      expect(JSON.stringify(response)).not.toContain("private-config-fixture");
      expect(JSON.parse(response.content[0]!.text)).toMatchObject({
        ok: true, configuration_id: input.configuration_id,
        configuration: { configuration_id: input.configuration_id },
      });
    }
    const current = await callback({ ...common, action: "get_configuration" });
    expect(JSON.parse(current.content[0]!.text)).toMatchObject({
      ok: true, configuration: { configuration_id: next.configuration_id },
    });
    const previous = await callback({ ...common, action: "get_configuration", configuration_id: first.configuration_id });
    expect(JSON.parse(previous.content[0]!.text)).toMatchObject({
      ok: true, configuration: { configuration_id: first.configuration_id },
    });
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
