import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startStarterPostgres, type StarterPostgres } from "./starter-postgres";
import { ensurePlatformV2SchemaInTransaction } from "../../packages/management-api/src/db/platform-v2";
import { executeSqlStatements } from "../../packages/management-api/src/db/sql-statements";
import {
  ApplicationActivationService, createApplicationActivationMutations,
  type ActivateApplicationInput, type ApplicationActiveRecord,
} from "../../packages/management-api/src/services/application-activation";
import { ApplicationActiveStorage } from "../../packages/management-api/src/services/application-active-storage";
import { runtimeInput } from "../../packages/management-api/tests/helpers/application-runtime";

const postgresBin = process.env.SUPACLOUD_STARTER_POSTGRES_BIN;
let postgres: StarterPostgres | undefined;
let database: SQL | undefined;
let root: string | undefined;

beforeAll(async () => {
  if (!postgresBin) return;
  root = await mkdtemp(join(tmpdir(), "application-native-"));
  postgres = await startStarterPostgres(postgresBin);
  database = await postgres.withConnection(async url => new SQL({ url, max: 6 }));
  // Minimal prerequisite tables; the mutation schema and migrations below are
  // the production implementation, not a copied or simplified journal schema.
  await executeSqlStatements(database, `
    CREATE TABLE organizations(id uuid PRIMARY KEY, owner_id text);
    CREATE TABLE organization_members(organization_id uuid, user_id text);
    CREATE TABLE projects(ref varchar(20) PRIMARY KEY, organization_id uuid, deleted_at timestamptz);
    CREATE TABLE project_tasks(project_ref varchar(20), status text, payload jsonb);
    CREATE TABLE audit_logs(id uuid PRIMARY KEY, project_ref varchar(50), created_at timestamptz);
    INSERT INTO projects(ref) VALUES ('demo');
  `);
  await ensurePlatformV2SchemaInTransaction(database);
}, 60_000);

afterAll(async () => {
  try { await database?.close({ timeout: 1 }); }
  finally {
    await postgres?.close();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(!postgresBin)("native mutation journal survives restart and fences unresolved application activation", async () => {
  if (!database || !postgres || !root) throw new Error("Native fixture missing");
  const storage = new ApplicationActiveStorage(join(root, "authority"));
  let route: ApplicationActiveRecord | null = null;
  const calls: string[] = [];
  const input: ActivateApplicationInput = {
    runtime: runtimeInput(), environment: { api: {}, jobs: {} },
    expectedActivationId: null, principal: { type: "project", id: "project:demo" },
    configurationId: "91234567-89ab-4def-8123-456789abcdef",
  };
  input.runtime.release.targets[0]!.name = "token";
  input.runtime.ports = { token: 31000 };
  input.environment = { token: {}, jobs: {} };
  input.hosts = { token: ["native.example.test"] };
  const makeService = (db: SQL) => new ApplicationActivationService({
    mutations: createApplicationActivationMutations(db),
    readActive: runtime => storage.read(runtime),
    writeActive: (record, expected) => storage.write(record, expected),
    confirmActive: record => storage.confirm(record),
    checkCompatibility: async () => {},
    prepare: async () => {},
    stop: async () => { calls.push("stop"); },
    start: async () => { calls.push("start"); },
    requireReady: async () => {},
    requireStopped: async () => {},
    route: async record => { route = record; },
    verifyRoute: async record => {
      if (route?.runtime.activationId !== record.runtime.activationId) throw new Error("route mismatch");
    },
  });
  expect((await makeService(database).activate(input)).replayed).toBe(false);
  const [before] = await database`SELECT status, checkpoint, receipt FROM project_mutations`;
  expect(before.status).toBe("succeeded");
  expect(before.checkpoint.phase).toBe("committed");
  expect(before.checkpoint.desired.configurationId).toBe(input.configurationId);
  expect(before.receipt.activation_id).toBe(input.runtime.activationId);
  await database.close({ timeout: 1 });
  database = undefined;
  await postgres.restart();
  database = await postgres.withConnection(async url => new SQL({ url, max: 6 }));
  expect((await makeService(database).activate(input)).replayed).toBe(true);
  expect(calls).toEqual(["start"]);
  const differentConfig = structuredClone(input);
  differentConfig.environment = { ...differentConfig.environment, token: { CHANGED: "value" } };
  await expect(makeService(database).activate(differentConfig)).rejects.toThrow("fingerprint_conflict");

  const prepared = structuredClone(input);
  prepared.runtime.activationId = "31234567-89ab-4def-8123-456789abcdef";
  prepared.expectedActivationId = input.runtime.activationId;
  const unreachable = async () => { throw new Error("unexpected runtime effect"); };
  const interrupted = new ApplicationActivationService({
    mutations: {
      ...createApplicationActivationMutations(database),
      // Simulate process death before the catch handler can persist failure.
      failure: async () => { throw new Error("simulated process termination"); },
    },
    readActive: runtime => storage.read(runtime),
    checkCompatibility: async () => {},
    prepare: async () => { throw new Error("prepare interruption"); },
    writeActive: unreachable, confirmActive: unreachable, stop: unreachable, start: unreachable,
    requireReady: unreachable, requireStopped: unreachable, route: unreachable, verifyRoute: unreachable,
  });
  await expect(interrupted.activate(prepared)).rejects.toThrow("simulated process termination");
  const [checkpoint] = await database`
    SELECT checkpoint FROM project_mutations WHERE mutation_id = ${prepared.runtime.activationId}
  `;
  expect(checkpoint.checkpoint.phase).toBe("prepared");
  expect(checkpoint.checkpoint.previous.runtime.ports).toEqual([{ target: "token", port: 31000 }]);
  expect(checkpoint.checkpoint.previous.hosts).toEqual([{ target: "token", hosts: ["native.example.test"] }]);
  // Advance only the owned fixture's lease deadline instead of waiting an hour.
  await database`
    UPDATE project_mutations
    SET lease_expires_at = clock_timestamp() - interval '1 second',
        recovery_not_before = clock_timestamp() - interval '1 second'
    WHERE mutation_id = ${prepared.runtime.activationId}
  `;
  await database.close({ timeout: 1 });
  database = undefined;
  await postgres.restart();
  database = await postgres.withConnection(async url => new SQL({ url, max: 6 }));
  expect((await makeService(database).activate(prepared)).replayed).toBe(false);
  const [resumed] = await database`
    SELECT status, fencing_epoch FROM project_mutations WHERE mutation_id = ${prepared.runtime.activationId}
  `;
  expect(resumed.status).toBe("succeeded");
  expect(Number(resumed.fencing_epoch)).toBe(2);
  expect(calls).toEqual(["start", "stop", "start"]);

  const failing = structuredClone(input);
  failing.runtime.activationId = "11234567-89ab-4def-8123-456789abcdef";
  failing.expectedActivationId = prepared.runtime.activationId;
  const service = new ApplicationActivationService({
    mutations: createApplicationActivationMutations(database),
    readActive: runtime => storage.read(runtime),
    writeActive: async () => { throw new Error("disk fault after route"); },
    confirmActive: record => storage.confirm(record),
    checkCompatibility: async () => {},
    prepare: async () => {},
    stop: async () => {},
    start: async () => {},
    requireReady: async () => {},
    requireStopped: async () => {},
    route: async record => { route = record; },
    verifyRoute: async () => {},
  });
  await expect(service.activate(failing)).rejects.toThrow("disk fault");
  const [failed] = await database`
    SELECT status, checkpoint FROM project_mutations WHERE mutation_id = ${failing.runtime.activationId}
  `;
  expect(failed.status).toBe("outcome_unknown");
  expect(failed.checkpoint.phase).toBe("routed");
  const conflicting = structuredClone(failing);
  conflicting.runtime.activationId = "21234567-89ab-4def-8123-456789abcdef";
  await expect(makeService(database).activate(conflicting)).rejects.toThrow("resource_busy");
  expect((await storage.read(input.runtime))?.runtime.activationId).toBe(prepared.runtime.activationId);
}, 60_000);

test.skipIf(!postgresBin)("expired committed activation is reconciled after restart without replaying runtime effects", async () => {
  if (!database || !postgres || !root) throw new Error("Native fixture missing");
  let directorySyncFails = false;
  const authority = new ApplicationActiveStorage(join(root, "recovery-authority"), {
    beforeDirectorySync: async () => {
      if (directorySyncFails) throw new Error("directory sync unavailable");
    },
  });
  const running = new Set<string>();
  const effects: string[] = [];
  let route: ApplicationActiveRecord | null = null;
  let processDeath = false;
  let authorityResponseLost = false;
  const make = (db: SQL) => {
    const mutations = createApplicationActivationMutations(db);
    return new ApplicationActivationService({
      mutations: {
        ...mutations,
        success: async (...args) => {
          if (processDeath) throw new Error("process terminated before receipt");
          return mutations.success(...args);
        },
        failure: async (...args) => {
          if (processDeath) throw new Error("process terminated before failure");
          return mutations.failure(...args);
        },
      },
      readActive: runtime => authority.read(runtime),
      writeActive: async (record, expected) => {
        await authority.write(record, expected);
        if (authorityResponseLost) throw new Error("authority response lost");
      },
      confirmActive: record => authority.confirm(record),
      checkCompatibility: async () => {}, prepare: async () => {},
      start: async runtime => { effects.push("start"); running.add(runtime.activationId); },
      stop: async runtime => { effects.push("stop"); running.delete(runtime.activationId); },
      requireReady: async runtime => {
        if (!running.has(runtime.activationId)) throw new Error("candidate stopped");
      },
      requireStopped: async runtime => {
        if (running.has(runtime.activationId)) throw new Error("previous still running");
      },
      route: async record => { effects.push("route"); route = record; },
      verifyRoute: async record => {
        if (route?.runtime.activationId !== record.runtime.activationId) throw new Error("route mismatch");
      },
    });
  };
  const input: ActivateApplicationInput = {
    runtime: { ...runtimeInput(), environmentId: "recovery", activationId: "41234567-89ab-4def-8123-456789abcdef" },
    environment: { api: {}, jobs: {} }, expectedActivationId: null,
    hosts: { api: ["native-recovery.example.test"] },
    configurationId: "91234567-89ab-4def-8123-456789abcdef",
    principal: { type: "project", id: "project:demo" },
  };
  await make(database).activate(input);
  const next = structuredClone(input);
  next.runtime.activationId = "51234567-89ab-4def-8123-456789abcdef";
  next.configurationId = "a1234567-89ab-4def-8123-456789abcdef";
  next.expectedActivationId = input.runtime.activationId;
  processDeath = true;
  await expect(make(database).activate(next)).rejects.toThrow("process terminated");
  processDeath = false;
  const recovery = {
    projectRef: "demo", applicationId: "reviews", environmentId: "recovery",
    activationId: next.runtime.activationId, principal: next.principal,
  };
  await expect(make(database).reconcile(recovery)).rejects.toThrow("busy");
  await expect(make(database).reconcile({ ...recovery, principal: { type: "project", id: "other" } }))
    .rejects.toThrow("IDENTITY_MISMATCH");
  const beforeEffects = [...effects];
  await database`
    UPDATE project_mutations SET lease_expires_at = clock_timestamp() - interval '1 second',
      recovery_not_before = clock_timestamp() - interval '1 second'
    WHERE mutation_id = ${next.runtime.activationId}
  `;
  await database.close({ timeout: 1 });
  database = undefined;
  await postgres.restart();
  database = await postgres.withConnection(async url => new SQL({ url, max: 6 }));
  const recovered = await make(database).reconcile(recovery);
  expect(recovered).toMatchObject({ activation_id: next.runtime.activationId, replayed: true });
  expect(effects).toEqual(beforeEffects);
  const [receipt] = await database`
    SELECT status, receipt, fencing_epoch FROM project_mutations WHERE mutation_id = ${next.runtime.activationId}
  `;
  expect(receipt.status).toBe("succeeded");
  expect(Number(receipt.fencing_epoch)).toBe(2);
  expect(receipt.receipt.reconciliation.evidence_code).toBe("RELEASE_AUTHORITY_CONFIRMED");
  expect((await authority.read(next.runtime))?.hosts).toEqual(next.hosts);
  expect((await authority.read(next.runtime))?.configurationId).toBe(next.configurationId);
  await expect(make(database).activate({
    ...next, configurationId: input.configurationId,
  })).rejects.toThrow("fingerprint_conflict");
  expect((await make(database).activate(next)).replayed).toBe(true);
  expect((await make(database).reconcile(recovery)).replayed).toBe(true);
  expect(effects).toEqual(beforeEffects);

  const subsequent = structuredClone(next);
  subsequent.runtime.activationId = "61234567-89ab-4def-8123-456789abcdef";
  subsequent.expectedActivationId = next.runtime.activationId;
  authorityResponseLost = true;
  await expect(make(database).activate(subsequent)).rejects.toThrow("authority response lost");
  authorityResponseLost = false;
  const afterEffects = [...effects];
  const [lost] = await database`
    SELECT status, checkpoint FROM project_mutations WHERE mutation_id = ${subsequent.runtime.activationId}
  `;
  expect(lost.status).toBe("outcome_unknown");
  expect(lost.checkpoint.phase).toBe("routed");
  expect((await make(database).reconcile({ ...recovery, activationId: subsequent.runtime.activationId })).replayed).toBe(true);
  expect(effects).toEqual(afterEffects);
  expect((await make(database).activate(subsequent)).replayed).toBe(true);
  const unsynced = structuredClone(subsequent);
  unsynced.runtime.activationId = "71234567-89ab-4def-8123-456789abcdef";
  unsynced.expectedActivationId = subsequent.runtime.activationId;
  directorySyncFails = true;
  await expect(make(database).activate(unsynced)).rejects.toThrow("directory sync unavailable");
  expect((await authority.read(unsynced.runtime))?.runtime.activationId).toBe(unsynced.runtime.activationId);
  const durabilityRecovery = { ...recovery, activationId: unsynced.runtime.activationId };
  await expect(make(database).reconcile(durabilityRecovery)).rejects.toThrow("directory sync unavailable");
  const [pendingSync] = await database`
    SELECT status FROM project_mutations WHERE mutation_id = ${unsynced.runtime.activationId}
  `;
  expect(pendingSync.status).toBe("outcome_unknown");
  directorySyncFails = false;
  const beforeSyncEffects = [...effects];
  expect((await make(database).reconcile(durabilityRecovery)).replayed).toBe(true);
  expect(effects).toEqual(beforeSyncEffects);
}, 60_000);
