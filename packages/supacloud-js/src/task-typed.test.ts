import { describe, expect, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import {
  createSupaCloudClient,
  SupaCloudTaskDecoderError,
  type SupaCloudTaskDetail,
  type SupaCloudTaskResultDecoder,
} from "./index";

const taskId = "task-typed-1";

function decodeResult(value: unknown): { value: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid result");
  }
  const record = value as { value?: unknown };
  if (typeof record.value !== "number") throw new Error("invalid result");
  return { value: record.value };
}

function taskDetail(status = "completed", result: unknown = { value: 42 }) {
  return {
    id: taskId,
    project_ref: "project",
    status,
    result,
  };
}

function createTaskClient(responses: readonly unknown[] = [taskDetail()]) {
  let responseIndex = 0;
  const requests: Request[] = [];
  const managementFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    const value = responses[Math.min(responseIndex++, responses.length - 1)];
    return Response.json(value);
  };
  const functionFetch = async () => Response.json({
    task_id: taskId,
    status: "pending",
    project_ref: "project",
  }, { status: 202 });
  const supabase = createClient("http://local", "fixture-key", {
    global: { fetch: functionFetch },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    client: createSupaCloudClient({
      supabase,
      managementApiUrl: "http://management",
      projectRef: "project",
      getAccessToken: () => "fixture-token",
    }),
    requests,
    managementFetch,
  };
}

describe("SupaCloud typed task receipts", () => {
  test("keeps the explicit result type across receipt operations and snapshots", async () => {
    type Result = { value: number };
    const decode: SupaCloudTaskResultDecoder<Result> = decodeResult;
    const { client, requests, managementFetch } = createTaskClient();
    const previousFetch = globalThis.fetch;
    globalThis.fetch = managementFetch;
    try {
      const receipt = await client.tasks.submitTyped("worker", { body: {} }, decode);
      const detail = await receipt.get();
      const waited = await receipt.wait({ intervalMs: 1 });
      const cancelled = await receipt.cancel();
      const retried = await receipt.retry();
      expect(detail.result).toEqual({ value: 42 });
      expect(waited.result).toEqual({ value: 42 });
      expect(cancelled.result).toEqual({ value: 42 });
      expect(retried.result).toEqual({ value: 42 });

      const snapshotPromise = new Promise<SupaCloudTaskDetail<Result>>(resolve => {
        const subscription = receipt.subscribe({
          pollingIntervalMs: 1,
          onUpdate(snapshot) {
            expect(snapshot.raw.result?.value).toBe(42);
            resolve(snapshot.raw);
            subscription.unsubscribe();
          },
        });
      });
      expect(await snapshotPromise).toEqual(taskDetail());
      expect(requests.length).toBeGreaterThanOrEqual(5);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("typed direct methods decode results without making an unchecked generic claim", async () => {
    type Result = { value: number };
    const decode: SupaCloudTaskResultDecoder<Result> = decodeResult;
    const { client, managementFetch } = createTaskClient([
      taskDetail("running"), taskDetail(), [taskDetail()], [taskDetail()],
    ]);
    const previousFetch = globalThis.fetch;
    globalThis.fetch = managementFetch;
    try {
      expect((await client.tasks.getTyped(taskId, decode)).result?.value).toBe(42);
      expect((await client.tasks.waitTyped(taskId, { intervalMs: 1 }, decode)).result?.value).toBe(42);
      expect((await client.tasks.listTyped({ status: "completed" }, decode))[0]?.result?.value).toBe(42);
      expect((await client.tasks.listDlqTyped(decode, 5))[0]?.result?.value).toBe(42);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("decoder failures are stable, redacted, and not replaced by response errors", async () => {
    const { client, managementFetch } = createTaskClient([
      taskDetail("completed", { secret: "do-not-leak" }),
      taskDetail("completed", { secret: "do-not-leak" }),
      [taskDetail("completed", { secret: "do-not-leak" })],
    ]);
    const previousFetch = globalThis.fetch;
    globalThis.fetch = managementFetch;
    try {
      const decoder = () => { throw new Error("secret-result-detail"); };
      const error = await client.tasks.getTyped(taskId, decoder).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(SupaCloudTaskDecoderError);
      expect(error).toMatchObject({
        name: "SupaCloudTaskDecoderError",
        code: "TASK_RESULT_INVALID",
        message: "Task result could not be decoded",
        mutationMayHaveApplied: false,
      });
      expect(error).not.toHaveProperty("cause");
      expect(error).not.toHaveProperty("secret-result-detail");

      const cancelError = await client.tasks.cancelTyped(taskId, decoder).catch((cause: unknown) => cause);
      expect(cancelError).toBeInstanceOf(SupaCloudTaskDecoderError);
      expect(cancelError).toMatchObject({ mutationMayHaveApplied: true });

      const listError = await client.tasks.listTyped(decoder).catch((cause: unknown) => cause);
      expect(listError).toBeInstanceOf(SupaCloudTaskDecoderError);
      expect(listError).toMatchObject({ operation: "list", mutationMayHaveApplied: false });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("requires a decoder before starting typed reads", () => {
    const { client } = createTaskClient();
    expect(() => client.tasks.getTyped(taskId, null as never)).toThrow("Invalid task result decoder");
    expect(() => client.tasks.waitTyped(taskId, {} as never, null as never)).toThrow("Invalid task result decoder");
  });
});
