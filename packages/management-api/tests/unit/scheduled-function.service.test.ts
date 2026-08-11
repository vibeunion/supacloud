import { beforeEach, describe, expect, mock, test } from "bun:test";

const SCHEDULE_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_SCHEDULE_ID = "00000000-0000-4000-8000-000000000002";
const UPDATED_AT = "2026-08-11T00:00:00.000Z";

let projectExists = true;
let projectConfig: Record<string, unknown> = {};
let updateCount = 0;
let transactionTail = Promise.resolve();
const executedQueries: string[] = [];

function queryText(strings: TemplateStringsArray): string {
  return strings.join("?").replaceAll(/\s+/g, " ").trim();
}

const database = Object.assign(
  mock(async (strings: TemplateStringsArray, ...parameters: unknown[]) => {
    const query = queryText(strings);
    executedQueries.push(query);
    if (query.startsWith("SELECT config FROM projects")) {
      return projectExists ? [{ config: structuredClone(projectConfig) }] : [];
    }
    if (query.startsWith("UPDATE projects")) {
      updateCount += 1;
      if (!query.includes("jsonb_set")) {
        const nextConfig = JSON.parse(String(parameters[0])) as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(projectConfig, "scheduled_functions")) {
          nextConfig.scheduled_functions = structuredClone(projectConfig.scheduled_functions);
        } else {
          delete nextConfig.scheduled_functions;
        }
        projectConfig = nextConfig;
        return projectExists ? [{ ref: String(parameters[1]), config: structuredClone(projectConfig) }] : [];
      }
      projectConfig = {
        ...projectConfig,
        scheduled_functions: JSON.parse(String(parameters[0])),
      };
      return projectExists ? [{ ref: String(parameters[1]) }] : [];
    }
    throw new Error(`Unexpected Scheduled Function query: ${query}`);
  }),
  {
    begin: async (mutation: (transaction: unknown) => Promise<unknown>) => {
      let releaseTransaction: () => void = () => {};
      const previousTransaction = transactionTail;
      transactionTail = new Promise<void>((resolve) => { releaseTransaction = resolve; });
      await previousTransaction;
      try {
        return await mutation(database);
      } finally {
        releaseTransaction();
      }
    },
  },
);

mock.module("../../src/db", () => ({ sql: database }));

const { scheduledFunctionService } = await import(
  new URL("../../src/services/scheduled-function.service.ts?scheduled-function-service-test", import.meta.url).href
);
const { projectRepository } = await import(
  new URL("../../src/repositories/project.repository.ts?scheduled-function-service-test", import.meta.url).href
);

function schedule(overrides: Record<string, unknown> = {}) {
  return {
    id: SCHEDULE_ID,
    name: "Nightly",
    slug: "worker",
    cron: "0 2 * * *",
    method: "POST" as const,
    enabled: true,
    created_at: UPDATED_AT,
    updated_at: UPDATED_AT,
    ...overrides,
  };
}

function storedSchedules(): Array<Record<string, unknown>> {
  return projectConfig.scheduled_functions as Array<Record<string, unknown>>;
}

describe("scheduledFunctionService", () => {
  beforeEach(() => {
    projectExists = true;
    projectConfig = { unrelated_setting: "preserved" };
    updateCount = 0;
    transactionTail = Promise.resolve();
    executedQueries.length = 0;
    database.mockClear();
  });

  test("creates under a row lock and preserves unrelated project config", async () => {
    const candidate = schedule();

    const outcome = await scheduledFunctionService.create({ ref: "proj_1", schedule: candidate });

    expect(outcome).toEqual({ kind: "created", schedule: candidate });
    expect(executedQueries[0]).toContain("FOR UPDATE");
    expect(executedQueries[1]).toContain("'{scheduled_functions}'");
    expect(projectConfig.unrelated_setting).toBe("preserved");
    expect(storedSchedules()).toEqual([candidate]);
  });

  test.each([
    ["name", schedule(), schedule({ id: OTHER_SCHEDULE_ID, slug: "other-worker" })],
    ["slug", schedule(), schedule({ id: OTHER_SCHEDULE_ID, name: "Other" })],
  ] as const)("atomically rejects concurrent duplicate %s creates", async (field, first, second) => {
    const outcomes = await Promise.all([
      scheduledFunctionService.create({ ref: "proj_1", schedule: first }),
      scheduledFunctionService.create({ ref: "proj_1", schedule: second }),
    ]);

    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["created", "duplicate"]);
    expect(outcomes).toContainEqual({ kind: "duplicate", field });
    expect(updateCount).toBe(1);
    expect(storedSchedules()).toHaveLength(1);
    expect(executedQueries.filter((query) => query.includes("FOR UPDATE"))).toHaveLength(2);
  });

  test("allows exactly one concurrent update for the same expected revision", async () => {
    projectConfig.scheduled_functions = [schedule()];

    const outcomes = await Promise.all([
      scheduledFunctionService.update({
        ref: "proj_1",
        scheduleId: SCHEDULE_ID,
        expectedUpdatedAt: UPDATED_AT,
        patch: { name: "First" },
      }),
      scheduledFunctionService.update({
        ref: "proj_1",
        scheduleId: SCHEDULE_ID,
        expectedUpdatedAt: UPDATED_AT,
        patch: { name: "Second" },
      }),
    ]);

    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(["revision_conflict", "updated"]);
    expect(updateCount).toBe(1);
    expect(storedSchedules()[0].updated_at).not.toBe(UPDATED_AT);
  });

  test("preserves a successful CAS revision when a stale generic config snapshot is written afterward", async () => {
    projectConfig.scheduled_functions = [schedule()];
    // A concurrent generic writer can capture this snapshot before the locked CAS and reach UPDATE after it.
    const staleGenericConfig = structuredClone(projectConfig);

    const scheduleOutcome = await scheduledFunctionService.update({
      ref: "proj_1",
      scheduleId: SCHEDULE_ID,
      expectedUpdatedAt: UPDATED_AT,
      patch: { enabled: false },
    });
    const genericOutcome = await projectRepository.updateConfig("proj_1", {
      ...staleGenericConfig,
      unrelated_setting: "updated",
    });

    expect(scheduleOutcome.kind).toBe("updated");
    expect(genericOutcome).not.toBeNull();
    expect(storedSchedules()[0].enabled).toBe(false);
    expect(storedSchedules()[0].updated_at).not.toBe(UPDATED_AT);
    expect(projectConfig.unrelated_setting).toBe("updated");
    expect(updateCount).toBe(2);
  });

  test("rejects a duplicate update name without changing either schedule", async () => {
    projectConfig.scheduled_functions = [
      schedule(),
      schedule({ id: OTHER_SCHEDULE_ID, name: "Other", slug: "other-worker" }),
    ];
    const before = structuredClone(projectConfig);

    const outcome = await scheduledFunctionService.update({
      ref: "proj_1",
      scheduleId: SCHEDULE_ID,
      expectedUpdatedAt: UPDATED_AT,
      patch: { name: "Other" },
    });

    expect(outcome).toEqual({ kind: "duplicate", field: "name" });
    expect(updateCount).toBe(0);
    expect(projectConfig).toEqual(before);
  });

  test("advances updated_at even when the stored revision is ahead of the server clock", async () => {
    const futureRevision = "2099-01-01T00:00:00.000Z";
    projectConfig.scheduled_functions = [schedule({ updated_at: futureRevision })];

    const outcome = await scheduledFunctionService.update({
      ref: "proj_1",
      scheduleId: SCHEDULE_ID,
      expectedUpdatedAt: futureRevision,
      patch: { enabled: false },
    });

    expect(outcome).toMatchObject({
      kind: "updated",
      schedule: { updated_at: "2099-01-01T00:00:00.001Z" },
    });
  });

  test("rejects stale update and delete revisions with zero mutation", async () => {
    projectConfig.scheduled_functions = [schedule()];
    const before = structuredClone(projectConfig);
    const staleRevision = "2026-08-10T23:59:59.999Z";

    const updateOutcome = await scheduledFunctionService.update({
      ref: "proj_1",
      scheduleId: SCHEDULE_ID,
      expectedUpdatedAt: staleRevision,
      patch: { enabled: false },
    });
    const deleteOutcome = await scheduledFunctionService.delete({
      ref: "proj_1",
      scheduleId: SCHEDULE_ID,
      expectedUpdatedAt: staleRevision,
    });

    expect(updateOutcome).toEqual({ kind: "revision_conflict" });
    expect(deleteOutcome).toEqual({ kind: "revision_conflict" });
    expect(updateCount).toBe(0);
    expect(projectConfig).toEqual(before);
  });

  test("deletes only the schedule bound to the expected revision", async () => {
    projectConfig.scheduled_functions = [schedule()];

    const outcome = await scheduledFunctionService.delete({
      ref: "proj_1",
      scheduleId: SCHEDULE_ID,
      expectedUpdatedAt: UPDATED_AT,
    });

    expect(outcome).toEqual({ kind: "deleted", deletedUpdatedAt: UPDATED_AT });
    expect(storedSchedules()).toEqual([]);
    expect(updateCount).toBe(1);
  });

  test("returns project_not_found without issuing an update", async () => {
    projectExists = false;

    const outcome = await scheduledFunctionService.create({ ref: "missing", schedule: schedule() });

    expect(outcome).toEqual({ kind: "project_not_found" });
    expect(updateCount).toBe(0);
  });
});
