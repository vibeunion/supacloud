import { describe, expect, test } from "bun:test";
import { summarizePowerSyncReadiness } from "../../src/services/replication-readiness";

describe("PowerSync replication readiness", () => {
  test("reports a ready logical replication source with spare capacity", () => {
    expect(summarizePowerSyncReadiness({
      settings: [
        { name: "wal_level", setting: "logical" },
        { name: "max_wal_senders", setting: "10" },
        { name: "max_replication_slots", setting: "10" },
        { name: "max_slot_wal_keep_size", setting: "10240" },
      ],
      slots: [
        {
          slot_type: "logical",
          active: true,
          wal_status: "reserved",
          retained_wal_bytes: "4096",
          unconfirmed_wal_bytes: "1024",
          safe_wal_size: "1048576",
        },
        { slot_type: "physical", active: false },
      ],
      publications: [{
        pubname: "powersync",
        puballtables: false,
        pubinsert: true,
        pubupdate: true,
        pubdelete: true,
        table_count: 4,
        replica_identity_missing_table_count: 0,
      }],
      activeWalSenders: 2,
    })).toEqual({
      provider: "powersync",
      ready: true,
      blockers: [],
      warnings: [],
      checks: {
        wal_level: { ok: true, actual: "logical" },
        wal_senders: { ok: true, configured: 10, active: 2, free: 8 },
        replication_slots: {
          ok: true,
          configured: 10,
          used: 2,
          free: 8,
          logical: 1,
          active_logical: 1,
        },
        logical_slot_health: {
          ok: true,
          invalid: 0,
          wal_unreserved: 0,
          wal_lost: 0,
          safe_wal_exhausted: 0,
          max_retained_wal_bytes: "4096",
          max_unconfirmed_wal_bytes: "1024",
          min_safe_wal_bytes: "1048576",
        },
        wal_retention: { setting: "10240", bounded: true },
        pending_restart: { ok: true, settings: [] },
        publications: {
          ok: true,
          count: 1,
          published_tables: 4,
          powersync: {
            present: true,
            all_tables: false,
            table_count: 4,
            publishes_insert: true,
            publishes_update: true,
            publishes_delete: true,
            replica_identity_missing_tables: 0,
          },
        },
      },
    });
  });

  test("fails closed when WAL, slot capacity, and publications are unavailable", () => {
    const result = summarizePowerSyncReadiness({
      settings: [
        { name: "wal_level", setting: "replica" },
        { name: "max_wal_senders", setting: "0" },
        { name: "max_replication_slots", setting: "1" },
      ],
      slots: [{ slot_type: "logical", active: false }],
      publications: [{ table_count: 0 }],
      activeWalSenders: 0,
    });

    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual([
      "WAL_LEVEL_NOT_LOGICAL",
      "WAL_SENDERS_DISABLED",
      "NO_FREE_REPLICATION_SLOT",
      "NO_PUBLISHED_TABLES",
      "POWERSYNC_PUBLICATION_MISSING",
    ]);
    expect(result.checks.replication_slots).toMatchObject({ free: 0, ok: false });
  });

  test("normalizes missing and malformed PostgreSQL settings to a blocked result", () => {
    const result = summarizePowerSyncReadiness({
      settings: [{ name: "max_replication_slots", setting: "invalid" }],
      slots: [],
      publications: [],
      activeWalSenders: "invalid",
    });

    expect(result.ready).toBe(false);
    expect(result.checks.wal_level.actual).toBe("unknown");
    expect(result.checks.replication_slots.configured).toBe(0);
    expect(result.blockers).toContain("REPLICATION_SLOTS_DISABLED");
  });

  test("blocks when every configured WAL sender is already active", () => {
    const result = summarizePowerSyncReadiness({
      settings: [
        { name: "wal_level", setting: "logical" },
        { name: "max_wal_senders", setting: "2" },
        { name: "max_replication_slots", setting: "3" },
      ],
      slots: [],
      publications: [{
        pubname: "powersync",
        pubinsert: true,
        pubupdate: true,
        pubdelete: true,
        table_count: 1,
      }],
      activeWalSenders: 2,
    });

    expect(result.ready).toBe(false);
    expect(result.blockers).toContain("NO_FREE_WAL_SENDER");
    expect(result.checks.wal_senders).toEqual({
      ok: false,
      configured: 2,
      active: 2,
      free: 0,
    });
  });

  test("reports PowerSync publication, slot WAL, and restart risks without hiding capacity", () => {
    const result = summarizePowerSyncReadiness({
      settings: [
        { name: "wal_level", setting: "logical", pending_restart: true },
        { name: "max_wal_senders", setting: "4" },
        { name: "max_replication_slots", setting: "4" },
        { name: "max_slot_wal_keep_size", setting: "-1" },
      ],
      slots: [{
        slot_type: "logical",
        active: false,
        wal_status: "lost",
        retained_wal_bytes: "9007199254740993",
        unconfirmed_wal_bytes: "8192",
        safe_wal_size: "0",
        invalidation_reason: "wal_removed",
      }],
      publications: [{
        pubname: "powersync",
        puballtables: true,
        pubinsert: true,
        pubupdate: false,
        pubdelete: true,
        table_count: 3,
        replica_identity_missing_table_count: 1,
      }],
      activeWalSenders: 1,
    });

    expect(result.ready).toBe(false);
    expect(result.blockers).toContain("POWERSYNC_PUBLICATION_DML_INCOMPLETE");
    expect(result.blockers).toContain("POWERSYNC_REPLICA_IDENTITY_INCOMPLETE");
    expect(result.warnings).toEqual([
      "POWERSYNC_PUBLICATION_ALL_TABLES",
      "INVALID_LOGICAL_SLOTS",
      "LOGICAL_SLOT_SAFE_WAL_EXHAUSTED",
      "SLOT_WAL_KEEP_SIZE_UNBOUNDED",
      "REPLICATION_SETTINGS_PENDING_RESTART",
    ]);
    expect(result.checks.logical_slot_health).toMatchObject({
      ok: false,
      invalid: 1,
      wal_lost: 1,
      safe_wal_exhausted: 1,
      max_retained_wal_bytes: "9007199254740993",
      max_unconfirmed_wal_bytes: "8192",
    });
  });
});
