// @supacloud-test-isolate
import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";

const authModule = await import("../../src/middleware/auth");
const databaseModule = await import("../../src/db");

const requireProjectOrAdminAuth = mock(async () => null);
const queries: string[] = [];

const tenantDb = async (strings: TemplateStringsArray) => {
  const query = strings.join("?");
  queries.push(query);
  if (query.includes("FROM pg_replication_slots")) {
    return [{
      slot_name: "powersync_proj_1",
      plugin: "pgoutput",
      slot_type: "logical",
      database: "supa_proj_1",
      active: true,
      restart_lsn: "0/100",
      confirmed_flush_lsn: "0/120",
      retained_wal_bytes: "4096",
      unconfirmed_wal_bytes: "1024",
      wal_status: "reserved",
      safe_wal_size: "1048576",
      inactive_since: null,
      conflicting: "false",
      invalidation_reason: null,
      failover: "false",
      synced: "false",
    }];
  }
  if (query.includes("FROM pg_publication publication")) {
    return [{
      pubname: "powersync",
      puballtables: false,
      pubinsert: true,
      pubupdate: true,
      pubdelete: true,
      pubtruncate: true,
      table_count: 3,
      replica_identity_missing_table_count: 0,
    }];
  }
  if (query.includes("FROM pg_settings")) {
    return [
      {
        name: "max_replication_slots",
        setting: "10",
        unit: null,
        source: "configuration file",
        pending_restart: false,
      },
      {
        name: "max_slot_wal_keep_size",
        setting: "10240",
        unit: "MB",
        source: "configuration file",
        pending_restart: false,
      },
      {
        name: "max_wal_senders",
        setting: "10",
        unit: null,
        source: "configuration file",
        pending_restart: false,
      },
      {
        name: "wal_level",
        setting: "logical",
        unit: null,
        source: "configuration file",
        pending_restart: false,
      },
    ];
  }
  if (query.includes("FROM pg_stat_replication")) {
    return [{ active_wal_senders: 1 }];
  }
  throw new Error(`Unexpected query: ${query}`);
};

const authSpy = spyOn(authModule, "requireProjectOrAdminAuth").mockImplementation(
  requireProjectOrAdminAuth as typeof authModule.requireProjectOrAdminAuth,
);
const resolveDbNameSpy = spyOn(databaseModule, "resolveDbName").mockResolvedValue("supa_proj_1");
const getProjectDbSpy = spyOn(databaseModule, "getProjectDb").mockReturnValue(tenantDb as never);

const { projectConfigRoutes } = await import(
  "../../src/routes/project-config?project-replication-config-routes-test"
);
const app = new Elysia().use(projectConfigRoutes);

afterAll(() => {
  authSpy.mockRestore();
  resolveDbNameSpy.mockRestore();
  getProjectDbSpy.mockRestore();
});

describe("project replication config route", () => {
  test("returns raw inventory and a read-only PowerSync readiness projection", async () => {
    queries.length = 0;
    const response = await app.handle(new Request(
      "http://localhost/v1/projects/proj_1/database/replication",
      { headers: { authorization: "Bearer dev-master-token" } },
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.replication_slots[0]).toMatchObject({
      slot_name: "powersync_proj_1",
      retained_wal_bytes: "4096",
    });
    expect(body.publications[0]).toMatchObject({ pubname: "powersync", table_count: 3 });
    expect(body.replication_settings).toMatchObject({
      wal_level: "logical",
      max_replication_slots: "10",
    });
    expect(body.replication_setting_details).toContainEqual(expect.objectContaining({
      name: "max_slot_wal_keep_size",
      unit: "MB",
      pending_restart: false,
    }));
    expect(body.powersync_readiness).toMatchObject({
      provider: "powersync",
      ready: true,
      blockers: [],
      warnings: [],
      checks: {
        wal_senders: { configured: 10, active: 1, free: 9 },
        logical_slot_health: {
          ok: true,
          max_retained_wal_bytes: "4096",
          max_unconfirmed_wal_bytes: "1024",
          min_safe_wal_bytes: "1048576",
        },
        publications: {
          powersync: {
            present: true,
            replica_identity_missing_tables: 0,
          },
        },
      },
    });
    expect(queries).toHaveLength(4);
    expect(queries.every((query) => /^\s*SELECT\b/i.test(query))).toBe(true);
  });
});
