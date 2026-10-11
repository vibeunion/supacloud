import { expect, test } from "bun:test";
import { SQL } from "bun";
import { Value } from "typebox/value";
import {
  applicationReleaseId,
  applicationHistoryCursor, ApplicationActivationHistorySchema,
  applicationHistoryPositionBefore, parseApplicationActivationHistory,
} from "@supacloud/delivery";
import {
  ApplicationActivationService, type ApplicationActiveRecord,
} from "../../src/services/application-activation";
import {
  ApplicationActivationHistoryReader, queryApplicationActivationHistory,
} from "../../src/services/application-history";
import { projectMutationResourceKey, readProjectMutation } from "../../src/services/project-mutation.service";
import { stableSha256, stableStringify } from "../../src/utils/stable-json";
import { createApplicationRoutes } from "../../src/routes/applications";
import { runtimeInput } from "../helpers/application-runtime";
import { activationJournal } from "../helpers/application-activation-journal";
import { withNativePostgres } from "../helpers/native-postgres";

const scope = { projectRef: "demo", applicationId: "reviews", environmentId: "test" };
const firstConfiguration = "91234567-89ab-4def-8123-456789abcdef";
const secondConfiguration = "a1234567-89ab-4def-8123-456789abcdef";
const firstCompletedAt = "2026-10-11T00:00:00.123456Z";
const secondCompletedAt = "2026-10-11T00:00:00.123457Z";
const resourceKey = projectMutationResourceKey({
  type: "application_release",
  id: stableSha256({ applicationId: scope.applicationId, environmentId: scope.environmentId }),
});

async function fixture() {
  const { journal, states } = activationJournal();
  const authority: { current: ApplicationActiveRecord | null } = { current: null };
  const activation = new ApplicationActivationService({
    mutations: journal,
    readActive: async () => structuredClone(authority.current),
    writeActive: async (record, expected) => {
      if ((authority.current?.runtime.activationId ?? null) !== expected) throw new Error("REVISION_CONFLICT");
      authority.current = structuredClone(record);
    },
    confirmActive: async () => undefined,
    checkCompatibility: async () => undefined,
    prepare: async () => undefined,
    stop: async () => undefined,
    start: async () => undefined,
    requireReady: async () => undefined,
    requireStopped: async () => undefined,
    route: async () => undefined,
    verifyRoute: async () => undefined,
  });
  const first = runtimeInput();
  await activation.activate({
    runtime: first,
    environment: { api: { SETTING: "old" }, jobs: {} },
    configurationId: firstConfiguration,
    expectedActivationId: null,
    principal: { type: "project", id: "project:demo" },
  });
  const next = runtimeInput();
  next.activationId = "11234567-89ab-4def-8123-456789abcdef";
  next.release.manifest_sha256 = "d".repeat(64);
  next.release.release_id = applicationReleaseId(scope.projectRef, scope.applicationId, next.release.manifest_sha256);
  next.ports = { api: 31001 };
  await activation.activate({
    runtime: next,
    environment: { api: { SETTING: "new" }, jobs: {} },
    configurationId: secondConfiguration,
    expectedActivationId: first.activationId,
    principal: { type: "project", id: "project:demo" },
  });
  const firstState = states.get(first.activationId)!;
  const secondState = states.get(next.activationId)!;
  firstState.completedAt = firstCompletedAt.slice(0, 23) + "Z";
  secondState.completedAt = secondCompletedAt.slice(0, 23) + "Z";
  firstState.resourceKey = resourceKey;
  secondState.resourceKey = resourceKey;
  const rows = [
    { activation_id: next.activationId, completed_at: secondCompletedAt },
    { activation_id: first.activationId, completed_at: firstCompletedAt },
  ];
  const calls: string[] = [];
  const reader = new ApplicationActivationHistoryReader({
    active: { readForApplication: async () => { calls.push("active"); return structuredClone(authority.current); } },
    mutations: { read: async (ref, id) => {
      calls.push(`journal:${id}`);
      expect(ref).toBe(scope.projectRef);
      return journal.read(ref, id);
    } },
    query: async ({ before, limit }) => {
      calls.push("query");
      return rows.filter(row => !before || applicationHistoryPositionBefore(row, before)).slice(0, limit);
    },
  });
  return { reader, states, current: authority.current, first, next, rows, calls };
}

test("returns completion-ordered pages with exact microsecond cursors and lineage", async () => {
  const f = await fixture();
  const firstPage = await f.reader.read(scope, { limit: 1 });
  expect(Value.Check(ApplicationActivationHistorySchema, firstPage)).toBe(true);
  expect(firstPage.activations).toHaveLength(1);
  expect(firstPage.activations[0]).toMatchObject({
    activation_id: f.next.activationId, completed_at: secondCompletedAt,
    configuration_id: secondConfiguration, previous_activation_id: f.first.activationId, is_active: true,
  });
  expect(firstPage.next_cursor).not.toBeNull();
  const secondPage = await f.reader.read(scope, { limit: 1, cursor: firstPage.next_cursor! });
  expect(secondPage.activations).toHaveLength(1);
  expect(secondPage.activations[0]).toMatchObject({
    activation_id: f.first.activationId, completed_at: firstCompletedAt,
    configuration_id: firstConfiguration, previous_activation_id: null, is_active: false,
  });
  expect(secondPage.next_cursor).toBeNull();
});

test.each(["missing", "failed", "foreign", "environment", "resource", "operation", "fingerprint", "phase",
  "receipt", "completion", "identity"] as const)("fails closed on %s journal evidence", async fault => {
  const f = await fixture();
  const state = f.states.get(f.next.activationId)!;
  switch (fault) {
    case "missing": f.states.delete(f.next.activationId); break;
    case "failed": state.status = "failed_terminal"; break;
    case "foreign": state.projectRef = "other"; break;
    case "environment": {
      const checkpoint = state.checkpoint.desired as { runtime: { environmentId: string } };
      checkpoint.runtime.environmentId = "production";
      break;
    }
    case "resource": state.resourceKey = "other"; break;
    case "operation": state.operation = "other.operation"; break;
    case "fingerprint": state.requestFingerprint = "f".repeat(64); break;
    case "phase": state.checkpoint.phase = "prepared"; break;
    case "receipt": state.receipt = { private: "must-not-escape" }; break;
    case "completion": state.completedAt = null; break;
    case "identity": state.mutationId = f.first.activationId; break;
  }
  await expect(f.reader.read(scope)).rejects.toMatchObject({
    code: "APPLICATION_HISTORY_UNVERIFIED", statusCode: 503,
  });
});

test("history is a public read projection and never scans artifacts or mutates the journal", async () => {
  const f = await fixture(), before = stableStringify([...f.states]);
  const result = await f.reader.read(scope);
  expect(result.activations.map(entry => entry.release_id)).toEqual([
    f.next.release.release_id, f.first.release.release_id,
  ]);
  expect(stableStringify([...f.states])).toBe(before);
  expect(f.calls).toEqual([
    "active", "query", `journal:${f.next.activationId}`, `journal:${f.first.activationId}`,
    `journal:${f.next.activationId}`, `journal:${f.first.activationId}`, "query", "active",
  ]);
  expect(JSON.stringify(result)).not.toMatch(/configurationDigest|checkpoint|SETTING|receipt|hosts/);
});

test("successful reconciliation completion order does not rewrite activation lineage", async () => {
  const f = await fixture(), old = f.states.get(f.first.activationId)!;
  const { parseSuccessfulApplicationActivation } = await import("../../src/services/application-activation");
  const desired = parseSuccessfulApplicationActivation(old, scope).desired;
  old.checkpoint.phase = "routed";
  old.receipt = { reconciliation: {
    source: "project.release.authority", observed_at: "2026-10-11T00:00:01.000Z",
    evidence_code: "RELEASE_AUTHORITY_CONFIRMED",
    evidence_fingerprint: stableSha256({ schema: "supacloud.application-activation-recovery.v1", desired }),
    target_status: "succeeded",
  } };
  old.completedAt = "2026-10-11T00:00:01.000Z";
  f.rows[1]!.completed_at = "2026-10-11T00:00:01.000001Z";
  f.rows.reverse();
  const history = await f.reader.read(scope);
  expect(history.activations[0]).toMatchObject({ activation_id: f.first.activationId, is_active: false });
  expect(history.activations[1]).toMatchObject({
    activation_id: f.next.activationId, previous_activation_id: f.first.activationId, is_active: true,
  });
});

test("empty and paged-out active observations never invent events", async () => {
  const f = await fixture();
  const exhausted = await f.reader.read(scope, {
    cursor: applicationHistoryCursor({
      project_ref: scope.projectRef, application_id: scope.applicationId, environment_id: scope.environmentId,
    }, f.rows[1]!),
  });
  expect(exhausted).toMatchObject({ active_activation_id: f.next.activationId, activations: [], next_cursor: null });
  const absent = new ApplicationActivationHistoryReader({
    active: { readForApplication: async () => null }, query: async () => [],
    mutations: { read: async () => { throw new Error("No events"); } },
  });
  expect(await absent.read(scope)).toMatchObject({ active_activation_id: null, activations: [], next_cursor: null });
});

test("rejects invalid page and foreign cursor before all reads", async () => {
  const f = await fixture();
  for (const limit of [0, 101, 1.5, NaN]) {
    await expect(f.reader.read(scope, { limit })).rejects.toMatchObject({ statusCode: 400 });
  }
  const foreign = applicationHistoryCursor({ project_ref: "other", application_id: "reviews", environment_id: "test" }, f.rows[0]!);
  await expect(f.reader.read(scope, { cursor: foreign })).rejects.toMatchObject({ statusCode: 400 });
  await expect(f.reader.read({ ...scope, applicationId: "../escape" })).rejects.toMatchObject({ statusCode: 400 });
  expect(f.calls).toEqual([]);
});

test.each(["duplicate", "reversed", "oversized", "timestamp", "timestamp-extra"] as const)(
  "rejects %s query evidence", async fault => {
    const f = await fixture();
    if (fault === "duplicate") f.rows[1] = { ...f.rows[0]! };
    if (fault === "reversed") f.rows.reverse();
    if (fault === "oversized") for (let i = 0; i < 100; i++) f.rows.push({ ...f.rows[0]! });
    if (fault === "timestamp") f.rows[0]!.completed_at = "2026-02-30T00:00:00.123457Z";
    if (fault === "timestamp-extra") f.rows[0]!.completed_at = "2026-10-11T00:00:00.1234578Z";
    const reader = new ApplicationActivationHistoryReader({
      active: { readForApplication: async () => f.current },
      mutations: { read: async (_ref, id) => structuredClone(f.states.get(id) ?? null) },
      query: async () => f.rows,
    });
    await expect(reader.read(scope)).rejects.toMatchObject({ statusCode: 503 });
  },
);

test.each(["active", "query", "journal", "earlier-journal"] as const)(
  "detects %s changing before final readback", async fault => {
    const f = await fixture();
    let activeReads = 0, queries = 0, reads = 0;
    const reader = new ApplicationActivationHistoryReader({
      active: { readForApplication: async () => {
        activeReads++;
        if (fault === "active" && activeReads > 1) return null;
        return structuredClone(f.current);
      } },
      mutations: { read: async (_ref, id) => {
        reads++;
        if (fault === "journal" && reads > 2) f.states.get(id)!.updatedAt = "2026-10-11T00:01:00.000Z";
        if (fault === "earlier-journal" && reads === 2) {
          f.states.get(f.next.activationId)!.updatedAt = "2026-10-11T00:01:00.000Z";
        }
        return structuredClone(f.states.get(id) ?? null);
      } },
      query: async () => {
        queries++;
        return fault === "query" && queries > 1 ? [] : f.rows;
      },
    });
    await expect(reader.read(scope)).rejects.toMatchObject({ code: "APPLICATION_HISTORY_CHANGED", statusCode: 409 });
  },
);

test("contradictory or foreign active authority fails closed even on empty pages", async () => {
  const f = await fixture();
  f.current!.configurationId = firstConfiguration;
  await expect(f.reader.read(scope)).rejects.toMatchObject({ statusCode: 503 });
  f.current!.runtime.environmentId = "other";
  const reader = new ApplicationActivationHistoryReader({
    active: { readForApplication: async () => f.current }, query: async () => [],
  });
  await expect(reader.read(scope)).rejects.toMatchObject({ statusCode: 503 });
});

test("history route forwards validated pagination and sanitizes provider errors", async () => {
  const f = await fixture();
  const app = createApplicationRoutes({
    projectExists: async () => true, authorize: async () => undefined, history: f.reader,
  });
  const url = "http://localhost/v1/projects/demo/applications/reviews/environments/test/history";
  const response = await app.handle(new Request(`${url}?limit=1`));
  expect(response.status).toBe(200);
  const history = parseApplicationActivationHistory(await response.json());
  expect(history.activations).toHaveLength(1);
  const next = await app.handle(new Request(`${url}?limit=1&cursor=${history.next_cursor}`));
  expect(next.status).toBe(200);
  expect(parseApplicationActivationHistory(await next.json()).activations[0]!.activation_id).toBe(f.first.activationId);
  for (const limit of ["0", "101", "1.5", "abc"]) {
    expect((await app.handle(new Request(`${url}?limit=${limit}`))).status).toBe(422);
  }
  f.states.get(f.next.activationId)!.receipt = { private: "must-not-escape" };
  const failed = await app.handle(new Request(url));
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({
    code: "APPLICATION_HISTORY_UNVERIFIED", error: "Application activation history is unavailable",
  });
});

test("authorization happens before history reads", async () => {
  let reads = 0;
  const app = createApplicationRoutes({
    projectExists: async () => true,
    authorize: async () => ({ status: 403, body: { error: "Access denied" } }),
    history: { read: async () => { reads++; throw new Error("Unexpected read"); } },
  });
  const response = await app.handle(new Request(
    "http://localhost/v1/projects/demo/applications/reviews/environments/test/history",
  ));
  expect(response.status).toBe(403);
  expect(reads).toBe(0);
});

test("native PostgreSQL query retains microsecond ordering and keyset boundaries", async () => {
  const f = await fixture();
  await withNativePostgres(async (database: SQL) => {
    await database.unsafe(`
      CREATE TABLE project_mutations (
        project_ref varchar(20) NOT NULL,
        mutation_id uuid NOT NULL,
        operation varchar(128) NOT NULL,
        resource_key varchar(255),
        status varchar(24) NOT NULL,
        completed_at timestamptz,
        request_fingerprint char(64), principal_type varchar(20), principal_id text,
        checkpoint jsonb, receipt jsonb, response_status integer,
        failure_code text, lease_owner text, lease_expires_at timestamptz,
        fencing_epoch bigint, created_at timestamptz, updated_at timestamptz,
        PRIMARY KEY (project_ref, mutation_id)
      )
    `);
    const newer = f.next.activationId;
    const older = f.first.activationId;
    await database`
      INSERT INTO project_mutations
        (project_ref, mutation_id, operation, resource_key, status, completed_at)
      VALUES
        (${scope.projectRef}, ${newer}, 'application.release.activate', ${resourceKey}, 'succeeded',
          ${secondCompletedAt}::timestamptz),
        (${scope.projectRef}, ${older}, 'application.release.activate', ${resourceKey}, 'succeeded',
          ${firstCompletedAt}::timestamptz),
        (${scope.projectRef}, ${crypto.randomUUID()}, 'application.release.activate', ${resourceKey}, 'failed_terminal',
          ${firstCompletedAt}::timestamptz)
    `;
    const page = await queryApplicationActivationHistory({
      scope, before: null, limit: 3,
    }, database);
    expect(page.map(row => row.completed_at)).toEqual([secondCompletedAt, firstCompletedAt]);
    const next = await queryApplicationActivationHistory({
      scope, before: page[0]!, limit: 3,
    }, database);
    expect(next).toEqual([{ activation_id: older, completed_at: firstCompletedAt }]);
    const sameMicrosecondId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await database`
      INSERT INTO project_mutations (project_ref, mutation_id, operation, resource_key, status, completed_at) VALUES
        ('other', ${crypto.randomUUID()}, 'application.release.activate', ${resourceKey}, 'succeeded',
          ${secondCompletedAt}::timestamptz),
        (${scope.projectRef}, ${sameMicrosecondId}, 'application.release.activate', ${resourceKey}, 'succeeded',
          ${secondCompletedAt}::timestamptz)
    `;
    const tied = await queryApplicationActivationHistory({ scope, before: null, limit: 4 }, database);
    expect(tied.map(row => row.activation_id)).toEqual([sameMicrosecondId, newer, older]);
    expect(await queryApplicationActivationHistory({ scope, before: tied[0]!, limit: 4 }, database)).toEqual(page);
    await expect(queryApplicationActivationHistory({ scope, before: null, limit: 0 }, database))
      .rejects.toMatchObject({ statusCode: 400 });
    await database`DELETE FROM project_mutations`;
    for (const row of f.rows) {
      const state = f.states.get(row.activation_id)!;
      await database`
        INSERT INTO project_mutations (
          project_ref, mutation_id, operation, resource_key, status, completed_at, request_fingerprint,
          principal_type, principal_id, checkpoint, receipt, response_status, failure_code,
          lease_owner, lease_expires_at, fencing_epoch, created_at, updated_at
        ) VALUES (
          ${state.projectRef}, ${state.mutationId}, ${state.operation}, ${state.resourceKey}, ${state.status},
          ${row.completed_at}::timestamptz, ${state.requestFingerprint}, ${state.principal.type}, ${state.principal.id},
          ${state.checkpoint}::jsonb, ${state.receipt}::jsonb, ${state.responseStatus}, null,
          null, null, ${state.fencingEpoch}, ${state.createdAt}::timestamptz, ${state.updatedAt}::timestamptz
        )
      `;
    }
    const reader = new ApplicationActivationHistoryReader({
      active: { readForApplication: async () => f.current },
      query: input => queryApplicationActivationHistory(input, database),
      mutations: { read: (projectRef, mutationId) => readProjectMutation({ projectRef, mutationId }, database) },
    });
    const firstPage = await reader.read(scope, { limit: 1 });
    expect(firstPage.activations[0]!.completed_at).toBe(secondCompletedAt);
    const secondPage = await reader.read(scope, { cursor: firstPage.next_cursor!, limit: 1 });
    expect(secondPage.activations[0]!.completed_at).toBe(firstCompletedAt);
  }, { image: "postgres:18.4-bookworm" });
}, 30_000);
