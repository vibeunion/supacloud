// @supacloud-test-isolate
import { expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { join } from "node:path";
import { config } from "../../src/config";
import { projectRepository } from "../../src/repositories/project.repository";
import { pgmqSettingsRepository } from "../../src/repositories/pgmq-settings.repository";
import { projectService } from "../../src/services";
import { pgmqService } from "../../src/services/pgmq.service";
import { taskRoutes } from "../../src/routes/tasks";
import { taskProjectFixture } from "../helpers/task-fixtures";
import { PgmqInputError } from "../../src/utils/pgmq-input";
import {
  pgmqSettingsPatch, pgmqSettingsProject, readPgmqSettings, PgmqSettingsError,
} from "../../src/utils/pgmq-settings";

const defaults = {
  max_in_flight: 10, default_visibility_timeout_sec: 330,
  max_attempts: 3, rate_limit_per_minute: 600,
};
const project = taskProjectFixture({ ref: "proj_1", config: {}, deleted_at: null });

test("raw queue configuration only defaults absent fields, never malformed stored values", () => {
  expect(readPgmqSettings({}, "jobs")).toEqual(defaults);
  expect(readPgmqSettings({ jobs: { max_attempts: 10 } }, "jobs")).toEqual({ ...defaults, max_attempts: 10 });
  expect(readPgmqSettings({ jobs: { ...defaults, future: true } }, "jobs")).toEqual(defaults);
  for (const value of [null, undefined, true, "3", -1, 0, 1.5, 11, NaN, Infinity]) {
    expect(() => readPgmqSettings({ jobs: { max_attempts: value } }, "jobs")).toThrow(PgmqSettingsError);
  }
  for (const value of [null, false, "", [], 0]) {
    expect(() => readPgmqSettings({ jobs: value }, "jobs")).toThrow(PgmqSettingsError);
  }
  for (const config of [null, undefined, "{}", "{", [], false,
    { queue_settings: null }, { queue_settings: [] }]) {
    expect(() => pgmqSettingsProject({ ...project, config }, "proj_1")).toThrow(PgmqSettingsError);
  }
  for (const value of [{ ...project, ref: "other" }, { ...project, deleted_at: "2026-09-10" }]) {
    expect(() => pgmqSettingsProject(value, "proj_1")).toThrow(PgmqSettingsError);
  }
  expect(() => readPgmqSettings({}, "jobs", true)).toThrow(PgmqSettingsError);
  let calls = 0;
  const accessor = Object.defineProperty({}, "max_attempts", { get() { calls++; return 3; } });
  expect(() => readPgmqSettings({ jobs: accessor }, "jobs")).toThrow(PgmqSettingsError);
  expect(calls).toBe(0);
});

test("patch validation is strict and captures only known owned integer fields", () => {
  expect(pgmqSettingsPatch({})).toEqual({});
  expect(pgmqSettingsPatch({
    max_in_flight: 100, default_visibility_timeout_sec: 1800,
    max_attempts: 10, rate_limit_per_minute: 60000,
  })).toEqual({
    max_in_flight: 100, default_visibility_timeout_sec: 1800,
    max_attempts: 10, rate_limit_per_minute: 60000,
  });
  for (const value of [null, [], "{}", { max_attempts: undefined }, { max_attempts: "3" },
    { max_in_flight: 101 }, { default_visibility_timeout_sec: 0 }, { rate_limit_per_minute: 60001 },
    { max_attempts: 1.1 }, { unknown: 1 }, Object.create({ max_attempts: 3 })]) {
    expect(() => pgmqSettingsPatch(value)).toThrow(PgmqInputError);
  }
  const input = { max_attempts: 5 };
  const captured = pgmqSettingsPatch(input);
  input.max_attempts = 8;
  expect(captured).toEqual({ max_attempts: 5 });
  expect(Object.isFrozen(captured)).toBe(true);
});

test("queue reads bypass lossy shared normalization and reject malformed project config", async () => {
  const find = spyOn(projectRepository, "findByRef");
  const normalized = spyOn(projectService, "getProjectSettings");
  try {
    for (const config of [null, "{}", [], { queue_settings: { jobs: { max_attempts: "3" } } }]) {
      find.mockResolvedValue(taskProjectFixture({ ...project, config }));
      await expect(projectService.getQueueSettings("proj_1", "jobs")).rejects.toThrow(PgmqSettingsError);
    }
    find.mockResolvedValue(project);
    expect(await projectService.getQueueSettings("proj_1", "jobs")).toEqual(defaults);
    find.mockResolvedValue(null);
    expect(await projectService.getQueueSettings("proj_1", "jobs")).toBeNull();
    expect(normalized).not.toHaveBeenCalled();
  } finally { find.mockRestore(); normalized.mockRestore(); }
});

test("updates validate before lookup and capture one source snapshot, preserving sibling config", async () => {
  const patch = { max_attempts: 5 };
  const source = {
    site_url: "https://example.test",
    queue_settings: { other: { max_attempts: 4 }, jobs: { max_in_flight: 2, future: { enabled: true } } },
  };
  const find = spyOn(projectRepository, "findByRef").mockImplementation(async () => {
    patch.max_attempts = 9;
    return taskProjectFixture({ ...project, config: source });
  });
  const update = spyOn(pgmqSettingsRepository, "compareAndUpdate").mockImplementation(async (_ref, _id, config, queues) =>
    taskProjectFixture({ ...project, config: { ...config, queue_settings: queues } }));
  const normalized = spyOn(projectService, "getProjectSettings");
  try {
    for (const value of [{ max_attempts: 0 }, { max_attempts: 1.2 }, { max_attempts: "3" }]) {
      const wire: unknown = value;
      await expect(projectService.updateQueueSettings("proj_1", "jobs",
        wire as Parameters<typeof projectService.updateQueueSettings>[2])).rejects.toThrow(PgmqInputError);
    }
    expect(find).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(await projectService.updateQueueSettings("proj_1", "jobs", patch)).toEqual({
      ...defaults, max_in_flight: 2, max_attempts: 5,
    });
    expect(find).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("proj_1", project.id, source,
      { other: { max_attempts: 4 }, jobs: { ...defaults, max_in_flight: 2, max_attempts: 5, future: { enabled: true } } });
    expect(normalized).not.toHaveBeenCalled();
  } finally { find.mockRestore(); update.mockRestore(); normalized.mockRestore(); }
});

test("invalid current config cannot be overwritten, and uncertain write receipts cannot become success", async () => {
  const find = spyOn(projectRepository, "findByRef");
  const update = spyOn(pgmqSettingsRepository, "compareAndUpdate");
  try {
    find.mockResolvedValue(taskProjectFixture({ ...project, config: { queue_settings: { jobs: { max_attempts: null } } } }));
    await expect(projectService.updateQueueSettings("proj_1", "jobs", { max_attempts: 4 })).rejects.toMatchObject({
      mutationMayHaveApplied: false,
    });
    expect(update).not.toHaveBeenCalled();
    find.mockResolvedValue(project);
    for (const receipt of [
      taskProjectFixture({ ...project, ref: "other" }),
      taskProjectFixture({ ...project, config: { queue_settings: { jobs: defaults } } }),
      taskProjectFixture({ ...project, config: { queue_settings: { jobs: { max_attempts: 4 } } } }),
    ]) {
      update.mockResolvedValue(receipt);
      await expect(projectService.updateQueueSettings("proj_1", "jobs", { max_attempts: 4 })).rejects.toMatchObject({
        mutationMayHaveApplied: true,
      });
    }
    update.mockRejectedValue(new Error("secret SQL credentials"));
    await expect(projectService.updateQueueSettings("proj_1", "jobs", {})).rejects.toThrow("Queue settings could not be validated");
  } finally { find.mockRestore(); update.mockRestore(); }
});

test("actual settings and receive routes use raw config validation and sanitized mutation uncertainty", async () => {
  const oldToken = config.masterToken;
  config.masterToken = "synthetic-pgmq-settings-test";
  const app = new Elysia().use(taskRoutes);
  const request = (path: string, method = "GET", body?: unknown, authorized = true) => app.handle(new Request(
    `http://localhost/v1/projects/proj_1/tasks/queues/jobs${path}`,
    { method, headers: {
      ...(authorized ? { authorization: `Bearer ${config.masterToken}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
  ));
  const find = spyOn(projectRepository, "findByRef").mockResolvedValue(project);
  const update = spyOn(pgmqSettingsRepository, "compareAndUpdate").mockImplementation(async (_ref, _id, config, queues) =>
    taskProjectFixture({ ...project, config: { ...config, queue_settings: queues } }));
  const read = spyOn(pgmqService, "read").mockResolvedValue([]);
  try {
    expect((await request("/settings", "PATCH", { max_attempts: 4 }, false)).status).toBe(401);
    expect(find).not.toHaveBeenCalled();
    expect((await request("/settings", "PATCH", { max_attempts: 1.5 })).status).toBe(400);
    expect(find).not.toHaveBeenCalled();
    expect(await (await request("/settings")).json()).toEqual(defaults);
    expect(await (await request("/settings", "PATCH", { max_attempts: 4 })).json()).toEqual({ ...defaults, max_attempts: 4 });
    find.mockResolvedValue(taskProjectFixture({ ...project, config: { queue_settings: { jobs: { max_in_flight: "2" } } } }));
    expect((await request("/messages/receive", "POST", {})).status).toBe(500);
    expect(read).not.toHaveBeenCalled();
    find.mockRejectedValue(new Error("secret repository statement"));
    const failedRead = await request("/settings");
    expect(failedRead.status).toBe(500);
    expect(await failedRead.text()).not.toContain("secret");
    find.mockResolvedValue(project);
    update.mockRejectedValue(new Error("synthetic lost write response"));
    const failedWrite = await request("/settings", "PATCH", { max_attempts: 4 });
    expect(failedWrite.status).toBe(503);
    expect(await failedWrite.json()).toMatchObject({
      code: "PGMQ_MUTATION_UNCONFIRMED", mutation_may_have_applied: true,
    });
  } finally { find.mockRestore(); update.mockRestore(); read.mockRestore(); config.masterToken = oldToken; }
});

test("settings decoder compiles with strict full-library checking", async () => {
  const child = Bun.spawn({
    cmd: [join(import.meta.dir, "../../node_modules/.bin/tsc"), "--ignoreConfig",
      "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--noUncheckedIndexedAccess",
      "--skipLibCheck", "false", "--module", "ESNext", "--moduleResolution", "bundler",
      "--target", "ESNext", "--types", "node", join(import.meta.dir, "../../src/utils/pgmq-settings.ts")],
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(code, `${stdout}\n${stderr}`).toBe(0);
}, 30_000);
