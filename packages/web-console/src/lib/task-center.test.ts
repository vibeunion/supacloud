import { describe, expect, test } from "bun:test";
import {
  backgroundSettingLimits, canCancelTask, canRetryTask, equalBackgroundSettings, InvalidTaskCenterResponse,
  parseBackgroundReceipt, parseBackgroundSettings, parseTaskDetail, parseTaskList, parseTaskMutation,
  parseTaskNotification, parseTaskRecord, requestTaskCenter, taskStatuses,
} from "./task-center";
import { backgroundSettings, otherTaskId, taskFixture, taskId, taskTime } from "./task-center.test-fixtures";
import { BACKGROUND_TASK_SETTING_LIMITS } from "../../../management-api/src/config/background-task-settings";

describe("task center boundary", () => {
  test("projects and task identities are required, not asserted", () => {
    expect(parseTaskDetail(taskFixture(), "a", taskId)).toEqual(taskFixture());
    for (const value of [null, {}, [], taskFixture("b"), { ...taskFixture(), id: otherTaskId }]) {
      expect(() => parseTaskDetail(value, "a", taskId)).toThrow(InvalidTaskCenterResponse);
    }
    expect(() => parseTaskList([taskFixture(), taskFixture()], "a")).toThrow();
    expect(() => parseTaskList([taskFixture()], "b")).toThrow();
    expect(() => parseTaskList([taskFixture()], "a", true)).toThrow();
    expect(parseTaskList([{ ...taskFixture(), status: "dead_lettered" }], "a", true)).toHaveLength(1);
  });
  test("every displayed task field is checked and unknown fields do not escape", () => {
    for (const patch of [
      { status: "unknown" }, { attempt: "1" }, { attempt: -1 }, { max_attempts: 0 },
      { max_attempts: Number.MAX_SAFE_INTEGER + 1 }, { error: {} }, { function_slug: 1 },
      { updated_at: "2026-02-30T01:02:03.000Z" }, { created_at: "" }, { lease_until: "never" },
      { cancel_requested_at: undefined }, { task_type: "" }, { id: "not-a-uuid" },
    ]) expect(() => parseTaskRecord({ ...taskFixture(), ...patch }, "a")).toThrow();
    expect(parseTaskRecord({ ...taskFixture(), authorization: "private" }, "a")).not.toHaveProperty("authorization");
  });
  test("attempts and logs cannot cross task/project or duplicate keyed identities", () => {
    const fixture = taskFixture();
    const attempt = fixture.attempts[0];
    if (!attempt) throw new Error("Missing fixture attempt");
    for (const patch of [
      { task_id: otherTaskId }, { project_ref: "b" }, { response_status: 600 },
      { duration_ms: -1 }, { logs: [{ timestamp: taskTime, stream: "unknown", level: "info", message: "" }] },
      { logs: false }, { attempt_no: 0 },
    ]) expect(() => parseTaskDetail({ ...fixture, attempts: [{ ...attempt, ...patch }] }, "a", taskId)).toThrow();
    expect(() => parseTaskDetail({ ...fixture, attempts: [attempt, attempt] }, "a", taskId)).toThrow();
    expect(() => parseTaskDetail({ ...fixture, latest_logs: [null] }, "a", taskId)).toThrow();
  });
  test("settings retain exact bounded integer values and the producer limits", () => {
    expect(BACKGROUND_TASK_SETTING_LIMITS).toEqual(backgroundSettingLimits);
    expect(parseBackgroundSettings(backgroundSettings)).toEqual(backgroundSettings);
    for (const key of Object.keys(backgroundSettingLimits)) {
      for (const value of [undefined, null, "", "3", 1.5, -1, 0, Infinity, Number.MAX_SAFE_INTEGER]) {
        expect(() => parseBackgroundSettings({ ...backgroundSettings, [key]: value })).toThrow();
      }
    }
    expect(() => parseBackgroundSettings({ ...backgroundSettings, timeout_sec_max: 100 })).toThrow();
    expect(() => parseBackgroundReceipt({ ...backgroundSettings, concurrency: 29 }, backgroundSettings)).toThrow();
    expect(equalBackgroundSettings(backgroundSettings, { ...backgroundSettings })).toBe(true);
  });
  test("retry and cancellation receipts retain the actual asynchronous semantics", () => {
    const pending = { ...taskFixture(), status: "pending", error: null, completed_at: null, next_run_at: taskTime };
    expect(parseTaskMutation(pending, "a", taskId, "retry").status).toBe("pending");
    for (const patch of [{ error: "error" }, { lease_until: taskTime }, { next_run_at: null }, { status: "failed" }]) {
      expect(() => parseTaskMutation({ ...pending, ...patch }, "a", taskId, "retry")).toThrow();
    }
    expect(() => parseTaskMutation(pending, "a", taskId, "cancel")).toThrow();
    expect(parseTaskMutation({ ...pending, status: "running", cancel_requested_at: taskTime }, "a", taskId, "cancel").status)
      .toBe("running");
    expect(parseTaskMutation({ ...pending, status: "cancelled" }, "a", taskId, "cancel").status).toBe("cancelled");
    for (const status of taskStatuses) {
      const task = { ...taskFixture(), status };
      expect(canRetryTask(task)).toBe(["failed", "dead_lettered", "cancelled"].includes(status));
      expect(canCancelTask(task)).toBe(["pending", "leased", "running", "retry_scheduled"].includes(status));
      expect(canCancelTask({ ...task, cancel_requested_at: taskTime })).toBe(false);
    }
  });
  test("socket messages only return a validated invalidation identity", () => {
    const event = { type: "task_update", projectRef: "a", taskId, taskType: "queue:work", status: "pending", timestamp: taskTime };
    expect(parseTaskNotification(JSON.stringify(event), "a")).toEqual({ taskId });
    for (const value of [
      null, {}, "null", "{", JSON.stringify({ ...event, projectRef: "b" }),
      JSON.stringify({ ...event, status: "invented" }), JSON.stringify({ ...event, timestamp: undefined }),
      JSON.stringify({ ...event, error: {} }), JSON.stringify({ ...event, progress: "10" }), " ".repeat(32769),
    ]) expect(parseTaskNotification(value, "a")).toBeNull();
  });
});

describe("task center transport", () => {
  const decode = (value: unknown) => parseTaskList(value, "a");
  test("rejects error/empty responses without exposing their body", async () => {
    for (const status of [201, 204, 400, 500]) {
      await expect(requestTaskCenter("/tasks", async () => new Response(status === 204 ? null : "secret", { status }), decode))
        .rejects.toThrow(InvalidTaskCenterResponse);
    }
    for (const value of ["null", "{}", "{"]) {
      await expect(requestTaskCenter("/tasks", async () => new Response(value), decode)).rejects.toThrow();
    }
  });
  test("enforces length/UTF-8/body limits and cancels rejected streams", async () => {
    let cancelled = false;
    await expect(requestTaskCenter("/tasks", async () => new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { headers: { "content-length": "8388609" } }), decode)).rejects.toThrow();
    expect(cancelled).toBe(true);
    await expect(requestTaskCenter("/tasks", async () => new Response(new Uint8Array([0xff])), decode)).rejects.toThrow();
    await expect(requestTaskCenter("/tasks", async () => new Response(new Uint8Array(8388609)), decode)).rejects.toThrow();
    await expect(requestTaskCenter("/tasks", async () => new Response("[]", { headers: { "content-length": "bad" } }), decode))
      .rejects.toThrow();
  });
  test("never replays mutations after invalid or mismatched receipts", async () => {
    let calls = 0;
    await expect(requestTaskCenter("/retry", async (_url, options) => {
      calls++;
      expect(options.method).toBe("POST");
      expect(options.redirect).toBe("error");
      return Response.json(taskFixture("b"));
    }, value => parseTaskMutation(value, "a", taskId, "retry"), { method: "POST" })).rejects.toThrow();
    expect(calls).toBe(1);
  });
  test("cancellation settles even when the transport ignores it and disposes late bodies", async () => {
    const response = Promise.withResolvers<Response>();
    const controller = new AbortController();
    const pending = requestTaskCenter("/tasks", () => response.promise, decode, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    let cancelled = false;
    response.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
  });
  test("an aborted caller never starts the request and body cancellation is bounded", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(requestTaskCenter("/tasks", async () => { calls++; return Response.json([]); }, decode,
      { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);
    const bodyController = new AbortController();
    const pending = requestTaskCenter("/tasks", async () => new Response(new ReadableStream()), decode,
      { signal: bodyController.signal });
    await Promise.resolve();
    bodyController.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
  test("the actual deadline settles a stalled request", async () => {
    await expect(requestTaskCenter("/tasks", () => new Promise<Response>(() => {}), decode))
      .rejects.toMatchObject({ name: "AbortError" });
  }, 20_000);
});
