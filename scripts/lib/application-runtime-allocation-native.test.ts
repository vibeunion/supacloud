import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applicationReleaseId } from "../../packages/delivery/src";
import { startStarterPostgres, type StarterPostgres } from "./starter-postgres";
import { ensureApplicationRuntimeAllocationSchema } from "../../packages/management-api/src/db/application-runtime-allocation-schema";
import {
  ApplicationRuntimeAllocations, type ApplicationRuntimeAllocationInput,
} from "../../packages/management-api/src/services/application-runtime-allocation";
import { runtimeInput } from "../../packages/management-api/tests/helpers/application-runtime";
import { ensurePlatformV2SchemaInTransaction } from "../../packages/management-api/src/db/platform-v2";
import { executeSqlStatements } from "../../packages/management-api/src/db/sql-statements";
import { ApplicationConfigurations } from "../../packages/management-api/src/services/application-configuration";
import { encryptSecretWithKey, decryptSecretWithKey } from "../../packages/management-api/src/utils/secret-crypto";
import { ApplicationDeploymentService } from "../../packages/management-api/src/services/application-deployment";
import { ApplicationReleaseStorage } from "../../packages/management-api/src/services/application-release-storage";
import { ApplicationActiveStorage } from "../../packages/management-api/src/services/application-active-storage";
import { ApplicationMigrations } from "../../packages/management-api/src/services/application-migrations";
import { applicationRuntimePlan } from "../../packages/management-api/src/services/application-runtime";
import { createApplicationActivationMutations } from "../../packages/management-api/src/services/application-activation";
import type { ApplicationGatewayInput } from "../../packages/management-api/src/services/application-gateway";
import { createApplicationRoutes } from "../../packages/management-api/src/routes/applications";
import { HttpTransport } from "../../packages/cli/src/shared/transports/http";
import { registerApplicationTools } from "../../packages/cli/src/shared/tools/application-tools";
import type { ReleaseControlToolResponse } from "../../packages/cli/src/shared/tools/release-control-response";

const postgresBin = process.env.SUPACLOUD_STARTER_POSTGRES_BIN;
let postgres: StarterPostgres | undefined;
let database: SQL;
let root: string;
function request(project = "demo"): ApplicationRuntimeAllocationInput {
  const { ports: _ports, ...runtime } = runtimeInput();
  runtime.activationId = randomUUID();
  runtime.release.project_ref = project;
  runtime.release.release_id = applicationReleaseId(project, runtime.release.application_id, runtime.release.manifest_sha256);
  return { runtime, configurationId: randomUUID() };
}
function allocator(start: number, end: number, available = async (_port: number) => true) {
  return new ApplicationRuntimeAllocations({ database, range: { start, end }, isAvailable: available });
}
beforeAll(async () => {
  if (!postgresBin) return;
  postgres = await startStarterPostgres(postgresBin);
  root = await mkdtemp(join(tmpdir(), "application-allocation-native-"));
  database = await postgres.withConnection(async url => new SQL({ url, max: 8 }));
  await executeSqlStatements(database, `
    CREATE TABLE organizations(id uuid PRIMARY KEY, owner_id text);
    CREATE TABLE organization_members(organization_id uuid, user_id text);
    CREATE TABLE projects(ref varchar(20) PRIMARY KEY, organization_id uuid, deleted_at timestamptz, config jsonb);
    CREATE TABLE project_tasks(project_ref varchar(20), status text, payload jsonb);
    CREATE TABLE audit_logs(id uuid PRIMARY KEY, project_ref varchar(50), created_at timestamptz);
    INSERT INTO projects(ref, config) VALUES ('demo', '{}'::jsonb);
  `);
  await ensurePlatformV2SchemaInTransaction(database);
  await database.begin(ensureApplicationRuntimeAllocationSchema);
}, 60_000);
afterAll(async () => {
  try { await database?.close({ timeout: 1 }); }
  finally {
    await postgres?.close();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(!postgresBin)("concurrent independent applications and retries cannot share an allocated port", async () => {
  const input = request();
  const service = allocator(20000, 20009);
  const repeated = await Promise.all([service.allocate(input), service.allocate(input)]);
  expect(repeated[0]).toEqual(repeated[1]);
  const other = request("other");
  const multiple = await Promise.all([service.allocate(request()), service.allocate(other)]);
  expect(new Set([repeated[0]!.runtime.ports.api, ...multiple.map(value => value.runtime.ports.api)]).size).toBe(3);
  const rows = await database`SELECT port FROM application_runtime_ports WHERE port BETWEEN 20000 AND 20009`;
  expect(rows).toHaveLength(3);
  expect(await service.read("wrong", input.runtime.activationId)).toBeNull();
  for (const changed of [
    { ...input, configurationId: randomUUID() },
    { ...input, runtime: { ...input.runtime, environmentId: "different" } },
    { ...input, runtime: { ...input.runtime, bunVersion: "1.4.3" } },
  ]) {
    await expect(service.allocate(changed)).rejects.toThrow("ALLOCATION_CONFLICT");
  }
});

test.skipIf(!postgresBin)("allocation ownership survives PostgreSQL restart and changed pool settings", async () => {
  const input = request(), old = await allocator(20100, 20101).allocate(input);
  await database.close({ timeout: 1 });
  await postgres!.restart();
  database = await postgres!.withConnection(async url => new SQL({ url, max: 8 }));
  const next = allocator(20200, 20201, async () => { throw new Error("Replay cannot reprobe"); });
  expect(await next.allocate(input)).toEqual(old);
  expect(await next.read("demo", input.runtime.activationId)).toEqual(old);
  const upgrade = await allocator(20100, 20101).allocate(request());
  expect(upgrade.runtime.ports.api).not.toBe(old.runtime.ports.api);
  await expect(allocator(20100, 20101).allocate(request())).rejects.toThrow("EXHAUSTED");
});

test.skipIf(!postgresBin)("occupied sockets and persisted tenant overrides are unavailable even without application claims", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port!, input = request();
  const service = new ApplicationRuntimeAllocations({ database, range: { start: port, end: port } });
  try {
    await expect(service.allocate(input)).rejects.toThrow("EXHAUSTED");
    expect(await service.read("demo", input.runtime.activationId)).toBeNull();
  } finally { await server.stop(true); }
  expect((await service.allocate(input)).runtime.ports.api).toBe(port);
  await database`INSERT INTO projects(ref, config) VALUES ('overrides', ${{
    postgrest_port: 20300, gotrue_port: "20301",
  }}::jsonb)`;
  await database`INSERT INTO projects(ref, config) VALUES ('legacy', to_jsonb(${JSON.stringify({ postgrest_port: 20302 })}::text))`;
  const reserved = request(), probe = allocator(20300, 20303);
  expect((await probe.allocate(reserved)).runtime.ports.api).toBe(20303);
  await expect(probe.allocate(request())).rejects.toThrow("EXHAUSTED");
});

test.skipIf(!postgresBin)("insufficient capacity or a failed probe leaves no partial allocation", async () => {
  const input = request();
  input.runtime.release.targets[1]!.kind = "http";
  const service = allocator(20400, 20400);
  await expect(service.allocate(input)).rejects.toThrow("EXHAUSTED");
  expect(await service.read("demo", input.runtime.activationId)).toBeNull();
  expect(await database`SELECT * FROM application_runtime_ports WHERE port = 20400`).toHaveLength(0);
  const interrupted = request();
  await expect(allocator(20400, 20401, async () => { throw new Error("probe unavailable"); }).allocate(interrupted))
    .rejects.toThrow("probe unavailable");
  expect(await service.read("demo", interrupted.runtime.activationId)).toBeNull();
  const completed = await allocator(20400, 20401).allocate(input);
  expect(Object.keys(completed.runtime.ports).sort()).toEqual(["api", "jobs"]);
  expect(new Set(Object.values(completed.runtime.ports)).size).toBe(2);
});

test.skipIf(!postgresBin)("worker-only allocations still bind revision identity and detect corrupted port claims", async () => {
  const worker = request();
  worker.runtime.release.targets = worker.runtime.release.targets.filter(target => target.kind === "worker");
  const service = allocator(20500, 20501);
  expect((await service.allocate(worker)).runtime.ports).toEqual({});
  const input = request(), allocated = await service.allocate(input);
  await database`DELETE FROM application_runtime_ports WHERE project_ref = 'demo' AND activation_id = ${input.runtime.activationId}`;
  await expect(service.read("demo", input.runtime.activationId)).rejects.toThrow("CORRUPT");
  await expect(service.allocate(input)).rejects.toThrow("CORRUPT");
  // Deliberate damage is repaired only inside this owned fixture for later assertions.
  await database`
    INSERT INTO application_runtime_ports VALUES (${allocated.runtime.ports.api}, 'demo', ${input.runtime.activationId}, 'api')
  `;
});

test.skipIf(!postgresBin)("a claim insertion failure rolls back the allocation and earlier target claims", async () => {
  const input = request();
  input.runtime.release.targets[1]!.kind = "http";
  const service = allocator(20800, 20801);
  await executeSqlStatements(database, `
    CREATE FUNCTION fail_allocation_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.target = 'jobs' AND NEW.port BETWEEN 20800 AND 20801 THEN
        RAISE EXCEPTION 'injected claim failure';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER fail_allocation_fixture BEFORE INSERT ON application_runtime_ports
      FOR EACH ROW EXECUTE FUNCTION fail_allocation_fixture();
  `);
  try {
    await expect(service.allocate(input)).rejects.toThrow("injected claim failure");
    expect(await service.read("demo", input.runtime.activationId)).toBeNull();
    expect(await database`SELECT * FROM application_runtime_ports WHERE port BETWEEN 20800 AND 20801`).toHaveLength(0);
  } finally {
    await database`DROP TRIGGER fail_allocation_fixture ON application_runtime_ports`;
    await database`DROP FUNCTION fail_allocation_fixture()`;
  }
  expect(Object.keys((await service.allocate(input)).runtime.ports)).toHaveLength(2);
});

test.skipIf(!postgresBin)("project metadata deletion cannot implicitly recycle a runtime port", async () => {
  const input = request("temporary");
  await database`INSERT INTO projects(ref, config) VALUES ('temporary', '{}'::jsonb)`;
  const service = allocator(20600, 20600), old = await service.allocate(input);
  await database`DELETE FROM projects WHERE ref = 'temporary'`;
  expect(await service.read("temporary", input.runtime.activationId)).toEqual(old);
  await expect(service.allocate(request())).rejects.toThrow("EXHAUSTED");
});

test.skipIf(!postgresBin)("retirement releases claims only after explicit stopped and unrouted proof", async () => {
  const input = request();
  const service = allocator(20900, 20901, async () => true);
  const original = await service.allocate(input);
  let verified = 0;
  await expect(service.retire("demo", input.runtime.activationId, async allocation => {
    verified++;
    expect(allocation.runtime.ports).toEqual(original.runtime.ports);
    throw new Error("APPLICATION_RUNTIME_NOT_STOPPED");
  })).rejects.toThrow("APPLICATION_RUNTIME_NOT_STOPPED");
  expect(verified).toBe(1);
  expect(await database`SELECT port FROM application_runtime_ports WHERE port = ${original.runtime.ports.api}`)
    .toHaveLength(1);
  const retired = await service.retire("demo", input.runtime.activationId, async allocation => {
    verified++;
    expect(allocation.runtime.ports).toEqual(original.runtime.ports);
  });
  expect(verified).toBe(2);
  expect(retired.retiredAt).toBeString();
  expect(await database`SELECT port FROM application_runtime_ports WHERE port = ${original.runtime.ports.api}`)
    .toHaveLength(0);
  expect(await service.retire("demo", input.runtime.activationId, async () => {
    throw new Error("Verifier must not rerun for an already retired allocation");
  })).toEqual(retired);
  await expect(service.allocate(input)).rejects.toThrow("APPLICATION_PORT_ALLOCATION_RETIRED");
  const replacement = await service.allocate(request("other"));
  expect([20900, 20901]).toContain(replacement.runtime.ports.api);
  expect(await database`SELECT port FROM application_runtime_ports WHERE port = ${replacement.runtime.ports.api}`)
    .toHaveLength(1);
});

test.skipIf(!postgresBin)("configured control-plane deployment and explicit rollback keep immutable port and revision identities", async () => {
  const input = request();
  input.runtime.environmentId = "configured";
  const key = randomBytes(32).toString("hex");
  const configurations = new ApplicationConfigurations(database, {
    encrypt: value => encryptSecretWithKey(value, key), decrypt: value => decryptSecretWithKey(value, key),
  });
  const scope = { projectRef: "demo", applicationId: "reviews", environmentId: "configured" };
  const initial = {
    configuration_id: input.configurationId, expected_configuration_id: null,
    configuration: { bun_version: "1.4.2", targets: [
      { name: "api", kind: "http", hosts: ["configured.example.test"], environment: { APP_SETTING: "first-fixture" } },
      { name: "jobs", kind: "worker", hosts: [], environment: {} },
    ] },
  };
  await configurations.put(scope, initial);
  const active = new ApplicationActiveStorage(join(root, "configured"));
  const running = new Set<string>(), starts: string[] = [], environments: string[] = [];
  let route: ApplicationGatewayInput | null = null;
  const storage = new class extends ApplicationReleaseStorage {
    override async readRelease() { return input.runtime.release; }
  }();
  const service = new ApplicationDeploymentService({
    configurations, allocations: allocator(20700, 20709), storage, active,
    mutations: createApplicationActivationMutations(database),
    migrations: new ApplicationMigrations({
      storage: { readMigrations: async () => ({
        record: input.runtime.release, archives: input.runtime.release.targets.map(target => ({
          target: target.name, objectId: target.object_id, artifactVerified: true, migrations: [],
        })),
      }) }, inventory: async () => [],
    }),
    verifyCompatibility: async ({ environment }) => {
      expect(["first-fixture", "second-fixture"]).toContain(environment.api!.APP_SETTING);
    },
    files: { prepare: async (_runtime, environment) => { environments.push(environment.api!.APP_SETTING!); return root; } },
    runtime: {
      install: async runtime => applicationRuntimePlan(runtime),
      start: async runtime => { running.add(runtime.activationId); starts.push(runtime.activationId); return []; },
      stop: async runtime => { running.delete(runtime.activationId); return []; },
      requireStopped: async runtime => { expect(running.has(runtime.activationId)).toBe(false); return []; },
    },
    readiness: { requireReady: async runtime => {
      expect(running.has(runtime.activationId)).toBe(true);
      return {
        project_ref: "demo", application_id: "reviews", environment_id: "configured",
        release_id: runtime.release.release_id, activation_id: runtime.activationId, ready: true,
        targets: applicationRuntimePlan(runtime).targets.map(target => ({
          target: target.name, kind: target.kind, unit: target.unit, pid: 123, invocation_id: "a".repeat(32),
          ready: true, code: "READY" as const,
        })),
      };
    } },
    gateway: {
      configureApplicationRoute: async desired => { route = structuredClone(desired); },
      verifyApplicationRoute: async desired => { expect(desired).toEqual(route!); },
    },
  });
  const principal = { type: "project" as const, id: "project:demo" };
  const routes = createApplicationRoutes({
    storage, configurations, deployment: service, authorize: async () => undefined,
    principal: async () => principal, projectExists: async () => true,
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: routes.fetch });
  let callback: ((args: Record<string, unknown>) => Promise<ReleaseControlToolResponse>) | undefined;
  registerApplicationTools({
    tool(_name, _description, _schema, handler) { callback = handler; },
  }, new HttpTransport({ baseUrl: server.url.toString(), token: "local-activation-test" }));
  const invoke = async (args: Record<string, unknown>) => {
    if (!callback) throw new Error("Applications CLI not registered");
    const response = await callback({
      ref: "demo", id: "reviews", environment_id: "configured", ...args,
    });
    const result = JSON.parse(response.content[0]!.text);
    expect(result.ok).toBe(true);
    return result;
  };
  const activate = async (desired: typeof input, expectedActivationId: string | null) => {
    return invoke({
      action: "activate_release", release_id: desired.runtime.release.release_id, activation_id: desired.runtime.activationId,
      configuration_id: desired.configurationId, expected_activation_id: expectedActivationId,
    });
  };
  try {
  await activate(input, null);
  const next = {
    ...input, configurationId: randomUUID(),
    runtime: { ...input.runtime, activationId: randomUUID() },
  };
  await configurations.put(scope, {
    ...initial, configuration_id: next.configurationId, expected_configuration_id: input.configurationId,
    configuration: {
      ...initial.configuration, targets: initial.configuration.targets.map(target =>
        target.kind === "http" ? { ...target, environment: { APP_SETTING: "second-fixture" } } : target),
    },
  });
  expect((await activate(input, null)).replayed).toBe(true);
  expect(starts).toEqual([input.runtime.activationId]);
  await activate(next, input.runtime.activationId);
  expect((await active.readForApplication("demo", "reviews", "configured"))?.configurationId).toBe(next.configurationId);
  const rollback = { ...input, runtime: { ...input.runtime, activationId: randomUUID() } };
  await activate(rollback, next.runtime.activationId);
  const current = await active.readForApplication("demo", "reviews", "configured");
  expect(current?.configurationId).toBe(input.configurationId);
  expect(environments).toEqual(["first-fixture", "second-fixture", "first-fixture"]);
  const claims = await database`
    SELECT runtime FROM application_runtime_allocations WHERE runtime->>'environmentId' = 'configured'
  `;
  expect(new Set(claims.map((row: { runtime: { ports: { api: number } } }) => row.runtime.ports.api)).size).toBe(3);
  expect((await configurations.read(scope))?.configuration_id).toBe(next.configurationId);
  expect((await invoke({
    action: "reconcile_activation", release_id: rollback.runtime.release.release_id,
    activation_id: rollback.runtime.activationId,
  })).replayed).toBe(true);
  expect(starts).toHaveLength(3);
  } finally { server.stop(true); }
});
