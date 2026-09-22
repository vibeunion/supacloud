import { expect, test } from "bun:test";
import { parseProjectOverview, loadProjectOverview } from "../../../lib/project-overview";
import { overviewFixture } from "../../../lib/project-overview.test-fixtures";

test("project overview decodes explicit unknown sections and rejects malformed or foreign summaries", () => {
  const valid = overviewFixture();
  expect(parseProjectOverview(valid, "a").tasks?.running).toBe(0);
  expect(parseProjectOverview({ ...valid, database: null, storage: null, tasks: null, active_queries: null }, "a").database).toBeNull();
  for (const value of [null, [], {}, { ...valid, project_ref: "b" }, { ...valid, tasks: undefined },
    { ...valid, database: { ...valid.database, connections: "1" } },
    { ...valid, database: { ...valid.database, cache_hit_ratio: 101 } },
    { ...valid, functions: { count: -1 } }, { ...valid, storage: { size: "-" } },
    { ...valid, auth: { ...valid.auth, source: "supauth", managed_by_ref: "../bad", total_users: null, recent_users: null } },
    { ...valid, auth: { ...valid.auth, source: "external" } },
    { ...valid, active_queries: [{ pid: 1, state: "active", usename: null, query: "" }, { pid: 1, state: "active", usename: null, query: "" }] },
  ]) expect(() => parseProjectOverview(value, "a")).toThrow();
  const user = { id: "u1", email: null, created_at: "2026-09-01T00:00:00.000Z" };
  expect(parseProjectOverview({ ...valid, auth: { ...valid.auth, recent_users: [user] } }, "a").auth.recent_users?.[0]?.email).toBeNull();
  for (const recent_users of [[user, user], [{ ...user, created_at: "2026-02-30T00:00:00.000Z" }]]) {
    expect(() => parseProjectOverview({ ...valid, auth: { ...valid.auth, recent_users } }, "a")).toThrow();
  }
});

test("overview transport bounds reads, validates identity and does not retry or issue legacy SQL", async () => {
  let calls = 0;
  const request = async (url: string, options: RequestInit) => {
    calls++;
    expect(url).toBe("/v1/projects/a/dashboard/summary");
    expect(options.cache).toBe("no-store");
    expect(options.redirect).toBe("error");
    return Response.json(overviewFixture());
  };
  await loadProjectOverview("a", request, new AbortController().signal);
  expect(() => loadProjectOverview("../b", request, new AbortController().signal)).toThrow();
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(loadProjectOverview("a", request, cancelled.signal)).rejects.toThrow();
  expect(calls).toBe(1);
  for (const response of [Response.json({}, { status: 503 }), Response.json(overviewFixture("b")),
    new Response("x".repeat(512 * 1024 + 1))]) {
    await expect(loadProjectOverview("a", async () => response, new AbortController().signal)).rejects.toThrow();
  }
});
