import { expect, test } from "bun:test";
import { buildInvocationRequest } from "../../src/services/background-function-worker";
import { InvalidBackgroundInvocationError, parseBackgroundInvocation } from "../../src/utils/background-invocation";
import { buildBackgroundForwardedRequest } from "../../../edge-runtime/background-forward";
import { taskFixture } from "../helpers/task-fixtures";

test("legacy invocation defaults are explicit and nested input is copied", () => {
  expect(parseBackgroundInvocation({})).toEqual({
    method: "POST", path: "", query: "", body: null, body_encoding: "utf8", headers: {}, auth: {},
  });
  const value = {
    headers: { "x-custom": "original" }, auth: { authorization: "Bearer original" },
    trace: { project_ref: "proj_1", traceparent: "original", request_id: "original" },
  };
  const parsed = parseBackgroundInvocation(value);
  value.headers["x-custom"] = "changed";
  value.auth.authorization = "changed";
  value.trace.request_id = "changed";
  expect(parsed.headers["x-custom"]).toBe("original");
  expect(parsed.auth.authorization).toBe("Bearer original");
  expect(parsed.trace?.request_id).toBe("original");
});

test("malformed payloads and ambiguous headers fail at the input boundary", () => {
  const invalid: unknown[] = [
    null, [], true, "{}", { method: "CONNECT" }, { method: "get" },
    { headers: [] }, { headers: { "bad header": "value" } },
    { headers: { "x-name": "line\nbreak" } }, { headers: { "x-name": 123 } },
    { headers: { "x-name": "\u4e2d" } }, { headers: { "X-Name": "one", "x-name": "two" } },
    { body: {} }, { body_encoding: "base64" }, { body: "x".repeat(1024 * 1024 + 1) },
    { requested_timeout_sec: 0 }, { requested_timeout_sec: 1.5 }, { requested_timeout_sec: 1801 },
    { auth: null }, { auth: { kind: "admin" } }, { auth: { authorization: "line\nbreak" } },
    { auth: { invoker_user_id: 123 } }, { trace: null },
    { path: "../other" }, { path: "/work?injected=1" }, { path: "/work\\other" },
    { query: "missing-equals" }, { query: "?q=1#fragment" },
    { method: "GET", body: "body" }, { method: "HEAD", body: "body" },
  ];
  for (const value of invalid) {
    expect(() => parseBackgroundInvocation(value)).toThrow(InvalidBackgroundInvocationError);
  }
});

test("Management POST transport roundtrips every supported logical method through Edge", async () => {
  for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const body = ["GET", "HEAD"].includes(method) ? null : "body";
    const task = taskFixture({ payload: { method, path: "/work", query: "?q=1", body } });
    const transport = buildInvocationRequest(task);
    expect(transport.method).toBe("POST");
    const forwarded = buildBackgroundForwardedRequest(transport, "synthetic-invocation-token");
    expect(forwarded.method).toBe(method);
    expect(new URL(forwarded.url).pathname).toEndWith("/my-function/work");
    expect(new URL(forwarded.url).search).toBe("?q=1");
    expect(await forwarded.text()).toBe(body ?? "");
    expect(forwarded.headers.has("x-supacloud-original-method")).toBe(false);
  }
});

test("client headers cannot override trusted background identity or transport", () => {
  const request = buildInvocationRequest(taskFixture({ payload: {
    headers: {
      "x-supacloud-task-id": "other-task", "x-supacloud-original-method": "DELETE",
      "x-supacloud-auth-authorization": "Bearer injected", "x-supacloud-jwt-sub": "injected",
      "authorization": "Bearer injected", "apikey": "injected", "content-length": "9999",
      "host": "other-host", "x-project-ref": "other-project", "baggage": "private",
      "x-custom": "preserved",
    },
  } }));
  expect(request.headers.get("x-supacloud-task-id")).toBe("tsk_1");
  expect(request.headers.get("x-supacloud-original-method")).toBe("POST");
  expect(request.headers.get("x-project-ref")).toBe("proj_1");
  expect(request.headers.get("x-custom")).toBe("preserved");
  for (const header of ["x-supacloud-auth-authorization", "x-supacloud-jwt-sub", "authorization",
    "apikey", "content-length", "host", "baggage"]) expect(request.headers.has(header)).toBe(false);
});

test("invalid routing identity and path normalization cannot dispatch to another function", () => {
  for (const overrides of [
    { project_ref: "../other" }, { function_slug: "fn/path" }, { id: "task\nid" },
    { attempt: 0 }, { attempt: 1.5 }, { function_version: "NaN" },
    { payload: { path: "/../other" } }, { payload: { path: "/%2e%2e/other" } },
    { payload: { path: "/white space" } },
  ]) expect(() => buildInvocationRequest(taskFixture(overrides))).toThrow(InvalidBackgroundInvocationError);
});
