import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { createSupaCloudClient } from "./index";

const commandId = "11111111-1111-4111-8111-111111111111";
const submission = { kind: "submission", commandId, execution: null, workflow: { runId: commandId, status: "queued" } };
function commandClient(initial: unknown = submission) {
  let response: unknown = initial;
  const calls: { url: string; body: unknown }[] = [];
  const supabase = createClient("https://project.example.com", "test-service-role-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (url, init) => {
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), body });
      return Response.json(response);
    } },
  });
  return {
    commands: createSupaCloudClient({ supabase, managementApiUrl: "https://management.example.com", projectRef: "project" }).commands,
    calls, respond: (value: unknown) => { response = value; },
  };
}
describe("SupaCloud command status client", () => {
  test("submit and get validate their shared status contract through real Supabase RPC serialization", async () => {
    const f = commandClient();
    const request = { commandId, commandType: "report.issue", targetType: "report", targetId: "report-1", payload: {}, maxAttempts: 4 };
    assert.deepEqual(await f.commands.submit(request), submission);
    assert.deepEqual(await f.commands.get(commandId), submission);
    assert.deepEqual(f.calls[0], { url: "https://project.example.com/rest/v1/rpc/supacloud_command_submit", body: { request } });
    assert.deepEqual(f.calls[1], { url: "https://project.example.com/rest/v1/rpc/supacloud_command_get", body: { request: { commandId } } });
  });
  test("lookup accepts an operation reference and rejects another tenant or command identity", async () => {
    const reference = { tenantId: "tenant", actorId: "actor", command: "webhook.update", operationId: "original-key" };
    const execution = { ...reference, dispatchKey: commandId, status: "confirmed", audit: "complete", result: true };
    const status = { kind: "execution", commandId, execution, workflow: null };
    const f = commandClient(status);
    assert.deepEqual(await f.commands.get(reference), status);
    assert.deepEqual(await f.commands.get({ commandId }), status);
    f.respond({ ...status, execution: { ...execution, tenantId: "other" } });
    await assert.rejects(f.commands.get(reference), /Mismatched command reference/);
    await assert.rejects(f.commands.get("22222222-2222-4222-8222-222222222222"), /Mismatched command status/);
  });
  test("malformed payloads, impossible state and submission/execution confusion fail closed", async () => {
    const f = commandClient();
    for (const value of [{}, [], { ...submission, workflow: null }, { ...submission, kind: "confirmed" }]) {
      f.respond(value);
      await assert.rejects(f.commands.get(commandId));
      await assert.rejects(f.commands.submit({ commandId, commandType: "test", targetType: "test", targetId: "one" }));
    }
    f.respond(null);
    expect(await f.commands.get(commandId)).toBe(null);
  });
});
