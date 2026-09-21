import { expect, spyOn, test } from "bun:test";
import { SQL, type BunPlugin } from "bun";
import { JSDOM } from "jsdom";
import { compile, compileModule, preprocess } from "svelte/compiler";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseProjectOverview, loadProjectOverview } from "../../../lib/project-overview";
import { overviewFixture } from "../../../lib/project-overview.test-fixtures";
import { readTaskStatistics, statisticsCount } from "../../../../../management-api/src/utils/task-statistics";
import {
  dashboardProject, dashboardRow, dashboardUsers, dashboardQueries, dashboardRatio, dashboardSize,
} from "../../../../../management-api/src/services/project-dashboard-data";
import { withNativePostgres, waitForPostgresFixture } from "../../../../../management-api/tests/helpers/native-postgres";

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

test("native dashboard values reject fabricated defaults, unsafe counts and duplicate display identities", () => {
  for (const value of [undefined, null, "", " 1", "1e3", true, -1, NaN, Infinity, "9007199254740992"]) {
    expect(() => statisticsCount(value)).toThrow();
  }
  expect(statisticsCount("0")).toBe(0);
  expect(dashboardRatio(null)).toBeNull();
  expect(dashboardRatio("99.1")).toBe(99.1);
  expect(() => dashboardRatio(undefined)).toThrow();
  expect(() => dashboardSize("-")).toThrow();
  expect(() => dashboardRow([])).toThrow();
  expect(() => dashboardProject({ ref: "a", db_name: undefined }, "a")).toThrow();
  const user = { id: "u1", email: null, created_at: new Date("2026-09-01T00:00:00.000Z") };
  expect(dashboardUsers([user])[0]?.created_at).toBe("2026-09-01T00:00:00.000Z");
  expect(() => dashboardUsers([user, user])).toThrow();
  expect(() => dashboardQueries([{ pid: 1, state: "idle", query: "", usename: "fixture" }])).toThrow();
  const stats = overviewFixture().tasks;
  expect(readTaskStatistics({ ...stats, running: "3" }).running).toBe(3);
  expect(() => readTaskStatistics({ ...stats, running: undefined })).toThrow();
  expect(() => readTaskStatistics({ ...stats, failedTrend: [{ bucket: "09-10 25:00", failures: 1 }] })).toThrow();
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

test("actual overview route and native PostgreSQL preserve tenant scope, unavailable sections and ownership", async () => {
  await withNativePostgres(async (database, url) => {
    const { projectDashboardRoutes, projectDashboardReads } = await import("../../../../../management-api/src/routes/project-dashboard");
    const { taskRepository } = await import("../../../../../management-api/src/repositories/task.repository");
    const { edgeFunctionService } = await import("../../../../../management-api/src/services/edge-function.service");
    const authModule = await import("../../../../../management-api/src/middleware/auth");
    const { config } = await import("../../../../../management-api/src/config");
    const token = config.masterToken;
    const owner = config.authRuntimeOwnerRef;
    config.masterToken = "project-overview-test-master-token";
    config.authRuntimeOwnerRef = "";
    const project = { ref: "a", db_name: "fixture", db_user: "fixture", db_password: "synthetic", config: {} };
    const read = spyOn(projectDashboardReads, "project").mockResolvedValue(project);
    const db = spyOn(projectDashboardReads, "database").mockReturnValue(database);
    const tasks = spyOn(taskRepository, "getTaskStats").mockResolvedValue(overviewFixture().tasks);
    const functions = spyOn(edgeFunctionService, "list").mockResolvedValue(["hello"]);
    let foreign: SQL | undefined;
    let foreignQuery: Promise<unknown> | undefined;
    const request = (authorized = true) => projectDashboardRoutes.handle(new Request("http://localhost/v1/projects/a/dashboard/summary", {
      headers: authorized ? { Authorization: "Bearer project-overview-test-master-token" } : {},
    }));
    const decoded = async () => {
      const response = await request();
      expect(response.status, response.status === 200 ? "" : await response.text()).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      return parseProjectOverview(await response.json(), "a");
    };
    try {
      expect((await request(false)).status).toBe(401);
      expect(read).not.toHaveBeenCalled();
      const auth = spyOn(authModule, "getAuthContext").mockResolvedValue({ role: "project", ref: "b", principalId: "project:b" });
      try { expect((await request()).status).toBe(403); } finally { auth.mockRestore(); }
      expect(read).not.toHaveBeenCalled();
      await database.unsafe(`
        CREATE SCHEMA auth;
        CREATE TABLE auth.users (id text PRIMARY KEY, email text, created_at timestamptz NOT NULL);
        INSERT INTO auth.users VALUES ('u1', NULL, '2026-09-01T00:00:00Z');
        CREATE SCHEMA storage;
        CREATE TABLE storage.objects (metadata jsonb);
        INSERT INTO storage.objects VALUES ('{"size":1024}');
      `);
      await database`CREATE DATABASE other_fixture`;
      const foreignUrl = new URL(url);
      foreignUrl.pathname = "/other_fixture";
      foreign = new SQL(foreignUrl.href, { max: 1 });
      foreignQuery = foreign.unsafe("SELECT pg_sleep(20) /* foreign-overview-marker */").then(() => {}, () => {});
      await waitForPostgresFixture(async () => {
        const rows: unknown = await database`SELECT pid FROM pg_stat_activity WHERE datname = 'other_fixture' AND state = 'active'`;
        return Array.isArray(rows) && rows.length === 1;
      });
      const full = await decoded();
      expect(full.database).not.toBeNull();
      expect(full.auth.total_users).toBe(1);
      expect(full.auth.recent_users?.[0]?.id).toBe("u1");
      expect(full.storage?.size).toBe("1024 bytes");
      expect(full.functions?.count).toBe(1);
      expect(full.active_queries?.some(query => query.query.includes("foreign-overview-marker"))).toBe(false);
      const local = dashboardRow(await database`SELECT count(*)::int AS total FROM pg_stat_activity WHERE backend_type = 'client backend' AND datname = current_database()`);
      expect(full.database?.connections).toBe(local.total);

      await database.unsafe(`UPDATE storage.objects SET metadata = '{}'`);
      tasks.mockRejectedValue(new Error("private task failure"));
      functions.mockRejectedValue(new Error("private function failure"));
      const partial = await decoded();
      expect(partial.storage).toBeNull();
      expect(partial.tasks).toBeNull();
      expect(partial.functions).toBeNull();
      expect(partial.auth.total_users).toBe(1);

      // A volatile view records local directory access even when rows are counted.
      await database.unsafe(`
        DROP TABLE auth.users;
        CREATE TABLE public.auth_probes (probe boolean);
        CREATE FUNCTION public.auth_probe() RETURNS text LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO public.auth_probes VALUES (true); RETURN 'leaked'; END $$;
        CREATE VIEW auth.users AS SELECT public.auth_probe() AS id, 'private'::text AS email, now() AS created_at;
      `);
      config.authRuntimeOwnerRef = "owner-project";
      expect((await decoded()).auth).toEqual({ source: "supauth", managed_by_ref: "owner-project", total_users: null, recent_users: null });
      config.authRuntimeOwnerRef = "";
      read.mockResolvedValue({ ...project, config: { auth: { third_party_auth: { enabled: true, auth_upstream: "https://auth.example.test" } } } });
      expect((await decoded()).auth.source).toBe("external");
      expect(await database`SELECT * FROM public.auth_probes`).toEqual([]);
      read.mockResolvedValue(project);
      functions.mockImplementationOnce(async () => {
        config.authRuntimeOwnerRef = "owner-project";
        return [];
      });
      const changedOwner = await request();
      expect(changedOwner.status).toBe(503);
      expect(await changedOwner.json()).toEqual({ code: "DASHBOARD_UNAVAILABLE", message: "Project dashboard unavailable" });
      config.authRuntimeOwnerRef = "";
      const closed = new SQL(url);
      await closed.close();
      db.mockReturnValueOnce(closed);
      const disconnected = await decoded();
      expect(disconnected.database).toBeNull();
      expect(disconnected.auth.total_users).toBeNull();
      expect(disconnected.auth.recent_users).toBeNull();
      expect(disconnected.active_queries).toBeNull();
      read.mockResolvedValueOnce(project).mockResolvedValue({ ...project, db_name: "changed" });
      expect((await request()).status).toBe(503);
      read.mockResolvedValue({ ...project, ref: "b" });
      expect((await request()).status).toBe(503);
      read.mockResolvedValue(null);
      expect((await request()).status).toBe(404);
    } finally {
      if (foreign) {
        await database`SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE datname = 'other_fixture'`;
        await foreignQuery;
        await foreign.close();
      }
      read.mockRestore(); db.mockRestore(); tasks.mockRestore(); functions.mockRestore();
      config.masterToken = token; config.authRuntimeOwnerRef = owner;
    }
  });
}, 60_000);

const localFile = (path: string) => fileURLToPath(new URL(path, import.meta.url));
function compiler(): BunPlugin {
  const typescript = new Bun.Transpiler({ loader: "ts" });
  return {
    name: "project-overview-tests",
    setup(builder) {
      builder.onResolve({ filter: /^(\$app\/(state|paths)|svelte-i18n)$/ },
        () => ({ path: localFile("overview.test-fixture.svelte.ts") }));
      builder.onResolve({ filter: /^\$lib\/(api|project-overview|project-services)$/ },
        ({ path }) => ({ path: localFile(`../../../lib/${path.slice("$lib/".length)}.ts`) }));
      builder.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
        const source = await preprocess(await Bun.file(path).text(), vitePreprocess(), { filename: path });
        return { contents: compile(source.code, { filename: path, generate: "client", css: "injected" }).js.code, loader: "js" };
      });
      builder.onLoad({ filter: /\.svelte\.[jt]s$/ }, async ({ path }) => ({
        contents: compileModule(typescript.transformSync(await Bun.file(path).text()),
          { filename: path, generate: "client" }).js.code, loader: "js",
      }));
    },
  };
}

test("compiled project overview clears unknown data and fences refresh, project transitions and unmount", async () => {
  if (process.env.SUPACLOUD_PROJECT_OVERVIEW_TEST !== "1") {
    const child = Bun.spawn({
      cmd: [process.execPath, "test", fileURLToPath(import.meta.url), "--test-name-pattern", "compiled project overview"],
      env: { ...process.env, SUPACLOUD_PROJECT_OVERVIEW_TEST: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    return;
  }
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
  const window = dom.window;
  Object.assign(globalThis, {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element, Node: window.Node, Text: window.Text, Comment: window.Comment,
    Event: window.Event, CustomEvent: window.CustomEvent, MouseEvent: window.MouseEvent,
    getComputedStyle: window.getComputedStyle.bind(window), MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  });
  const bundlePath = join(tmpdir(), `supacloud-project-overview-${crypto.randomUUID()}.mjs`);
  try {
    const result = await Bun.build({
      entrypoints: [localFile("overview.test-entry.ts")], target: "browser", format: "esm",
      conditions: ["svelte", "browser"], external: ["node:assert"], plugins: [compiler()],
    });
    if (!result.success) throw new AggregateError(result.logs, "Overview fixture build failed");
    const output = result.outputs[0];
    if (!output) throw new Error("Missing overview fixture bundle");
    await Bun.write(bundlePath, output);
    await import(pathToFileURL(bundlePath).href);
  } finally { await rm(bundlePath, { force: true }); dom.window.close(); }
}, 30_000);
