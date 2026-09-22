// @supacloud-test-isolate
import { expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { parseProjectOverview } from "../../../web-console/src/lib/project-overview";
import { overviewFixture } from "../../../web-console/src/lib/project-overview.test-fixtures";
import { readTaskStatistics, statisticsCount } from "../../src/utils/task-statistics";
import {
  dashboardProject, dashboardRow, dashboardUsers, dashboardQueries, dashboardRatio, dashboardSize,
} from "../../src/services/project-dashboard-data";
import { withNativePostgres, waitForPostgresFixture } from "../helpers/native-postgres";
import { edgeFunctionService } from "../../src/services/edge-function.service";
import { taskRepository } from "../../src/repositories/task.repository";
import * as authModule from "../../src/middleware/auth";
import { config } from "../../src/config";
import { projectDashboardReads, projectDashboardRoutes } from "../../src/routes/project-dashboard";

test("native dashboard values reject fabricated defaults, unsafe counts and duplicate display identities", () => {
  for (const value of [undefined, null, "", " 1", "1e3", true, -1, Number.NaN, Infinity, "9007199254740992"]) {
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

test("overview route and native PostgreSQL preserve tenant scope, unavailable sections and ownership", async () => {
  await withNativePostgres(async (database, url) => {
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
