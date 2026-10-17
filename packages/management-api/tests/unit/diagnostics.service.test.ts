import { beforeEach, expect, mock, test } from "bun:test";

let rows: Record<string, unknown>[] = [];
mock.module("../../src/db", () => ({
  sql: mock(async () => rows),
  getProjectDb: mock(() => { throw new Error("No project database expected"); }),
}));
mock.module("../../src/diagnostics/checks/index", () => ({}));

const { getRun, listRuns, getRunResults } = await import("../../src/services/diagnostics.service");

const summary = {
  total: 1, pass: 1, drift: 0, missing: 0, tampered: 0, unreachable: 0, degraded: 0, error: 0,
};
const runRow = {
  id: "run-1", scope: "project", project_ref: "project-1", status: "completed",
  started_at: "2026-10-10T00:00:00Z", completed_at: new Date("2026-10-10T00:01:00Z"), summary,
};
const resultRow = {
  id: "result-1", run_id: "run-1", check_id: "check-1", status: "pass",
  message: "Valid", detail: null, repair_preview: null, repair_command: null,
  metadata: { verified: true }, created_at: new Date("2026-10-10T00:00:30Z"),
};

beforeEach(() => { rows = []; });

test("diagnostic history decodes valid records and nullable fields", async () => {
  expect(await getRun("missing")).toBeNull();
  rows = [{ ...runRow, summary: JSON.stringify(summary) }];
  expect(await getRun("run-1")).toEqual({
    id: "run-1", scope: "project", projectRef: "project-1", status: "completed",
    startedAt: new Date(runRow.started_at), completedAt: runRow.completed_at, summary,
  });
  rows = [{ ...runRow, status: "running", completed_at: null, summary: null }];
  expect(await listRuns({ scope: "project", projectRef: "project-1" })).toMatchObject([
    { status: "running", completedAt: null, summary: null },
  ]);
  rows = [resultRow];
  expect(await getRunResults("run-1")).toMatchObject([
    { status: "pass", detail: null, metadata: { verified: true }, createdAt: resultRow.created_at },
  ]);
});

test("unknown run scopes and statuses never become successful history", async () => {
  for (const [field, value] of [
    ["scope", "unknown"], ["scope", null], ["status", "unknown"], ["status", null],
  ]) {
    rows = [{ ...runRow, [String(field)]: value }];
    await expect(getRun("run-1")).rejects.toThrow(TypeError);
    await expect(listRuns({})).rejects.toThrow(TypeError);
  }
});

test("invalid dates are rejected even when supplied as Date instances", async () => {
  for (const value of [new Date(NaN), "invalid", "", NaN, false]) {
    for (const field of ["started_at", "completed_at"]) {
      rows = [{ ...runRow, [field]: value }];
      await expect(getRun("run-1")).rejects.toThrow("Invalid diagnostic timestamp");
    }
    rows = [{ ...resultRow, created_at: value }];
    await expect(getRunResults("run-1")).rejects.toThrow("Invalid diagnostic timestamp");
  }
  rows = [{ ...runRow, completed_at: 0 }];
  expect((await getRun("run-1"))?.completedAt).toEqual(new Date(0));
});

test("malformed summaries and non-string nullable fields fail closed", async () => {
  for (const value of [[], {}, { ...summary, total: -1 }, { ...summary, pass: 0.5 }]) {
    rows = [{ ...runRow, summary: value }];
    await expect(getRun("run-1")).rejects.toThrow(TypeError);
  }
  rows = [{ ...runRow, project_ref: { ref: "project-1" } }];
  await expect(getRun("run-1")).rejects.toThrow(TypeError);
  for (const field of ["detail", "repair_preview", "repair_command"]) {
    rows = [{ ...resultRow, [field]: 42 }];
    await expect(getRunResults("run-1")).rejects.toThrow(TypeError);
  }
});

test("invalid result statuses and metadata are not discarded or accepted", async () => {
  rows = [{ ...resultRow, status: "completed" }];
  await expect(getRunResults("run-1")).rejects.toThrow("Invalid diagnostic result status");
  for (const metadata of [[], "{}", 42]) {
    rows = [{ ...resultRow, metadata }];
    await expect(getRunResults("run-1")).rejects.toThrow("Invalid diagnostic metadata");
  }
});
