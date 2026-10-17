import { expect, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import { createSupaCloudClient } from "./index.js";

function fixture(response: unknown, status = 200) {
  const calls: { url: string; body: unknown }[] = [];
  const supabase = createClient("http://127.0.0.1:54321", "synthetic-anon", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json" } });
    } },
  });
  const queue = createSupaCloudClient({ supabase, projectRef: "project-a", managementApiUrl: "http://127.0.0.1:54322" }).queue("jobs");
  return { calls, queue };
}

test("real SDK distinguishes a new enqueue from durable deduplication without rounding IDs", async () => {
  for (const created of [true, false]) {
    const { calls, queue } = fixture([{ msg_id: "9007199254740993", created }]);
    const input = { revision: 1 };
    const pending = queue.sendIdempotent(input, "report:1", { sleepSeconds: 2 });
    input.revision = 2;
    expect(await pending).toEqual({ id: "9007199254740993", msg_id: "9007199254740993", queue_name: "jobs",
      status: created ? "pending" : "deduplicated", payload: { revision: 1 }, deduplicated: !created });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/rpc/send_idempotent");
    expect(calls[0]!.body).toEqual({ queue_name: "jobs", message: { revision: 1 }, p_job_key: "report:1", sleep_seconds: 2 });
  }
});

test("malformed receipts are uncertain writes, not successful deduplication", async () => {
  const invalid: unknown[] = [null, [], [null], [[]], [{ msg_id: "1" }],
    ...[null, 0, 1, "false", "true", {}].map(created => [{ msg_id: "1", created }]),
    [{ msg_id: "0", created: false }], [{ msg_id: "9223372036854775808", created: true }],
    [{ msg_id: "1", created: true }, { msg_id: "2", created: true }]];
  for (const response of invalid) {
    const { calls, queue } = fixture(response);
    await expect(queue.sendIdempotent({}, "same-key")).rejects.toMatchObject({ mutationMayHaveApplied: true });
    expect(calls).toHaveLength(1);
  }
});

test("invalid input never dispatches and upstream failures are never blindly retried", async () => {
  const { calls, queue } = fixture([{ msg_id: "1", created: true }]);
  for (const key of ["", "key\n", "a".repeat(201)]) {
    await expect(queue.sendIdempotent({}, key)).rejects.toMatchObject({ mutationMayHaveApplied: false });
  }
  expect(calls).toHaveLength(0);
  const failed = fixture({ code: "temporary", message: "synthetic private details" }, 503);
  await expect(failed.queue.sendIdempotent({}, "same-key")).rejects.toMatchObject({ mutationMayHaveApplied: true });
  expect(failed.calls).toHaveLength(1);
});
