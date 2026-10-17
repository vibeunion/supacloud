import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applicationHistoryCursor, parseApplicationActivationHistory, parseApplicationHistoryCursor,
  type ApplicationActivationHistory,
} from "@supacloud/delivery";
import { APPLICATION_TOOL_SCHEMA, registerApplicationTools } from "./application-tools";
import { registerAppTools } from "./app-tools";
import type { ToolInvocation, ToolServer } from "../tool-server";
import type { HttpTransport } from "../transports/http";
import { authorizeExecution, executionMode, validateExecutionPolicyCoverage } from "../execution-policy";
import { resolveSupaCloudContext } from "../context";
import { parseToolArguments } from "../schema";

const scope = { project_ref: "demo", application_id: "reviews", environment_id: "test" };
const cliArgs = { action: "get_history", ref: "demo", id: "reviews", environment_id: "test" };

function fixture(): ApplicationActivationHistory {
  return {
    schema: "supacloud.application-activation-history.v1", ...scope,
    active_activation_id: "11234567-89ab-4def-8123-456789abcdef",
    activations: [
      {
        activation_id: "11234567-89ab-4def-8123-456789abcdef",
        completed_at: "2026-10-11T00:00:00.123457Z", release_id: "d".repeat(64),
        configuration_id: "91234567-89ab-4def-8123-456789abcdef",
        previous_activation_id: "01234567-89ab-4def-8123-456789abcdef", is_active: true,
      },
      {
        activation_id: "01234567-89ab-4def-8123-456789abcdef",
        completed_at: "2026-10-11T00:00:00.123456Z", release_id: "a".repeat(64),
        configuration_id: null, previous_activation_id: null, is_active: false,
      },
    ],
    next_cursor: null,
  };
}

function applicationTool(data: unknown, status = 200) {
  let handler: ToolInvocation | undefined;
  const requests: string[] = [];
  registerApplicationTools({
    tool(name, _description, schema, callback) {
      validateExecutionPolicyCoverage({ [name]: { schema } });
      handler = callback;
    },
  }, {
    get: async (path: string) => {
      requests.push(path);
      return { ok: status >= 200 && status < 300, status, data };
    },
    post: async () => { throw new Error("History must never write"); },
  } as unknown as HttpTransport);
  if (!handler) throw new Error("Missing applications tool");
  return { handler, requests };
}

test("shared cursor and history contracts reject noncanonical and contradictory evidence", () => {
  const history = fixture(), cursor = applicationHistoryCursor(scope, history.activations[0]!);
  expect(parseApplicationHistoryCursor(cursor, scope)).toEqual({
    completed_at: history.activations[0]!.completed_at, activation_id: history.activations[0]!.activation_id,
  });
  for (const invalid of [cursor + "=", "A", "_w", "", "a".repeat(1025)]) {
    expect(() => parseApplicationHistoryCursor(invalid, scope)).toThrow();
  }
  for (const invalid of [
    { ...history, extra: "must-not-escape" },
    { ...history, activations: [history.activations[0], history.activations[0]] },
    { ...history, activations: [...history.activations].reverse() },
    { ...history, active_activation_id: null },
    { ...history, next_cursor: cursor },
    { ...history, activations: [{ ...history.activations[0], previous_activation_id: history.activations[0]!.activation_id }] },
    { ...history, activations: [{ ...history.activations[0], completed_at: "2026-02-30T00:00:00.000000Z" }] },
  ]) expect(() => parseApplicationActivationHistory(invalid)).toThrow();
});

test("CLI validates scope, sends one GET and preserves exact next-page cursors", async () => {
  const history = fixture();
  const page = {
    ...history, activations: history.activations.slice(0, 1),
    next_cursor: applicationHistoryCursor(scope, history.activations[0]!),
  };
  const tool = applicationTool(page);
  const response = await tool.handler({ ...cliArgs, limit: 1 });
  expect(JSON.parse(response.content[0]!.text)).toMatchObject({
    ok: true, operation: "applications.get_history", history: page,
  });
  expect(tool.requests).toEqual(["/v1/projects/demo/applications/reviews/environments/test/history?limit=1"]);
  expect(parseToolArguments(APPLICATION_TOOL_SCHEMA, { ...cliArgs, cursor: page.next_cursor, limit: 1 }))
    .toMatchObject({ cursor: page.next_cursor });
  const next = applicationTool({ ...history, activations: history.activations.slice(1) });
  expect((await next.handler({ ...cliArgs, cursor: page.next_cursor, limit: 1 })).isError).not.toBe(true);
  expect(next.requests).toEqual([
    `/v1/projects/demo/applications/reviews/environments/test/history?limit=1&cursor=${page.next_cursor}`,
  ]);
});

test("CLI rejects foreign or malformed page arguments before HTTP", async () => {
  const history = fixture(), tool = applicationTool(history);
  const cursor = applicationHistoryCursor({ ...scope, environment_id: "production" }, history.activations[0]!);
  for (const change of [
    { cursor }, { cursor: "A" }, { limit: 0 }, { limit: 101 }, { limit: 1.5 },
    { environment_id: undefined }, { environment_id: "../other" },
  ]) await expect(tool.handler({ ...cliArgs, ...change })).rejects.toThrow();
  expect(tool.requests).toEqual([]);
});

test.each(["foreign", "oversized", "partial-next", "contradiction", "private", "reversed", "timestamp", "before"] as const)(
  "CLI rejects %s successful history without reflecting remote data", async fault => {
    const history = fixture();
    let data: unknown = history;
    let limit = 20, cursor: string | undefined;
    if (fault === "foreign") data = { ...history, environment_id: "production" };
    if (fault === "oversized") limit = 1;
    if (fault === "partial-next") data = {
      ...history, next_cursor: applicationHistoryCursor(scope, history.activations[1]!),
    };
    if (fault === "contradiction") data = { ...history, active_activation_id: null };
    if (fault === "private") data = { ...history, private: "must-not-escape" };
    if (fault === "reversed") data = { ...history, activations: [...history.activations].reverse() };
    if (fault === "timestamp") data = {
      ...history, activations: [{ ...history.activations[0], completed_at: "2026-02-30T00:00:00.000000Z" }],
    };
    if (fault === "before") cursor = applicationHistoryCursor(scope, history.activations[0]!);
    const result = await applicationTool(data).handler({ ...cliArgs, limit, ...(cursor ? { cursor } : {}) });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
    expect(result.content[0]!.text).not.toContain("must-not-escape");
  },
);

test.each([201, 202, 204, 409, 503])("CLI does not accept HTTP %d as a complete history", async status => {
  const result = await applicationTool(fixture(), status).handler(cliArgs);
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0]!.text)).toMatchObject({
    ok: false, error: { code: status < 300 ? "INVALID_RESPONSE" : "HTTP_ERROR", http_status: status },
  });
});

function appTool(delegate: ToolInvocation) {
  let handler: ToolInvocation | undefined;
  registerAppTools({
    tool(name, _description, schema, callback) {
      validateExecutionPolicyCoverage({ [name]: { schema } });
      handler = callback;
    },
  } satisfies ToolServer, { getApplications: () => delegate, projectRef: "demo" });
  if (!handler) throw new Error("Missing app tool");
  return handler;
}

test("app history defaults to a summary and JSON flags preserve full receipts", async () => {
  const history = fixture();
  history.activations = history.activations.slice(0, 1);
  history.next_cursor = applicationHistoryCursor(scope, history.activations[0]!);
  const handler = appTool(applicationTool(history).handler);
  const args = { action: "history", id: "reviews", environment_id: "test", limit: 1 };
  const text = (await handler(args)).content[0]!.text;
  expect(text).toContain("Activation History: demo/reviews/test");
  expect(text).toContain("current");
  expect(text).toContain(history.active_activation_id!);
  expect(text).toContain(`Next cursor: ${history.next_cursor}`);
  expect(text).not.toContain('"schema"');
  for (const format of [{ json: true }, { format: "json" }]) {
    const result = await handler({ ...args, ...format });
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: true, history });
  }
  await expect(handler({ ...args, json: true, format: "text" })).rejects.toThrow("cannot be combined");
  const empty: ApplicationActivationHistory = { ...history, activations: [], next_cursor: null };
  const emptyText = await appTool(applicationTool(empty).handler)(args);
  expect(emptyText.content[0]!.text).toContain("No successful activations on this page.");
  expect(emptyText.content[0]!.text).not.toContain("Next cursor:");
});

test("history is read-only in production and cannot cross project boundaries", () => {
  const context = resolveSupaCloudContext({
    SUPACLOUD_API_URL: "https://management.example.test",
    SUPACLOUD_API_TOKEN: "synthetic-test-token",
    SUPACLOUD_PROJECT_REF: "demo",
    SUPACLOUD_ENV: "production", SUPACLOUD_READ_ONLY: "true",
  });
  for (const [module, action] of [["app", "history"], ["applications", "get_history"]] as const) {
    expect(executionMode(module, action, {})).toBe("read");
    expect(() => authorizeExecution(module, { action, ref: "demo" }, { context })).not.toThrow();
    expect(() => authorizeExecution(module, { action, ref: "other" }, { context })).toThrow("cannot target");
  }
});

test("CLI process handles JSON flags, scoped help and read-only production", async () => {
  const history = fixture(), root = await mkdtemp(join(tmpdir(), "application-history-cli-"));
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) { requests.push(request.method); return Response.json(history); },
  });
  const entry = fileURLToPath(new URL("../../index.ts", import.meta.url));
  const environment = Object.fromEntries(Object.entries(process.env).filter(
    ([key, value]) => value !== undefined && !/^(SUPACLOUD_|SUPABASE_|X_PROJECT_REF$|MANAGEMENT_API_URL$)/.test(key),
  ));
  try {
    await Bun.write(join(root, ".env.supacloud.prod"), [
      "SUPACLOUD_ENV=production", "SUPACLOUD_PROJECT_REF=demo", "SUPACLOUD_READ_ONLY=true",
      `SUPACLOUD_API_URL=http://127.0.0.1:${server.port}`, "SUPACLOUD_API_TOKEN=synthetic-test-token",
    ].join("\n") + "\n");
    const run = async (flags: string[]) => {
      const child = Bun.spawn([process.execPath, entry, "--env", "prod", "app", "history", ...flags], {
        cwd: root, env: environment, stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    };
    const flags = ["--id", "reviews", "--environment_id", "test"];
    const text = await run(flags);
    if (text.code !== 0) throw new Error(`CLI history failed: ${text.stderr}\n${text.stdout}`);
    expect(text.stdout).toContain("Completed (UTC)");
    for (const output of [["--json"], ["--format", "json"]]) {
      const result = await run([...flags, ...output]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, history });
    }
    const help = await run(["--help"]);
    expect(help.stderr).toContain("--json");
    expect(help.stderr).toContain("--cursor");
    const foreign = await run([...flags, "--ref", "other"]);
    expect(foreign.code).toBe(1);
    expect(foreign.stderr).toContain("cannot target a different project");
    expect(requests).toEqual(["GET", "GET", "GET"]);
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
}, 30_000);
