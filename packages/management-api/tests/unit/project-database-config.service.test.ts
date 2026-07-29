import { describe, expect, mock, test } from "bun:test";
import {
  DatabaseConfigValidationError,
  liveSettingNumber,
  parseDatabaseConfigPatch,
  quoteDatabaseIdentifier,
  readLiveDatabaseSettings,
  updateDatabaseSettings,
} from "../../src/services/project-database-config.service";

describe("project database config validation", () => {
  test("accepts timeout boundaries and pure numeric strings", () => {
    expect(parseDatabaseConfigPatch({
      statement_timeout: "0",
      idle_in_transaction_session_timeout: 2_147_483_647,
    })).toEqual({
      statement_timeout: 0,
      idle_in_transaction_session_timeout: 2_147_483_647,
    });
  });

  test("preserves typed PgBouncer metadata without treating it as SQL", () => {
    expect(parseDatabaseConfigPatch({
      pgbouncer_enabled: true,
      pgbouncer_settings: { pool_mode: "transaction", default_pool_size: 15 },
    })).toEqual({
      pgbouncer_enabled: true,
      pgbouncer_settings: { pool_mode: "transaction", default_pool_size: 15 },
    });
    expect(() => parseDatabaseConfigPatch({ pgbouncer_enabled: "yes" }))
      .toThrow("pgbouncer_enabled must be a boolean");
    expect(() => parseDatabaseConfigPatch({ pgbouncer_settings: [] }))
      .toThrow("pgbouncer_settings must be an object");
  });

  test.each([
    -1,
    2_147_483_648,
    1.5,
    "1s",
    "0; DROP DATABASE postgres",
    true,
    null,
  ])("rejects an unsafe timeout value: %p", (setting) => {
    expect(() => parseDatabaseConfigPatch({ statement_timeout: setting }))
      .toThrow(DatabaseConfigValidationError);
  });

  test("rejects max_connections before any other setting", () => {
    try {
      parseDatabaseConfigPatch({
        max_connections: 200,
        statement_timeout: 10,
      });
      throw new Error("Expected validation to fail");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(DatabaseConfigValidationError);
      expect((error as DatabaseConfigValidationError).code).toBe(
        "INVALID_SETTING_SCOPE",
      );
    }
  });

  test.each([
    {},
    { work_mem: 1024 },
    { statement_timeout: 10, injected_setting: "on" },
  ])("rejects empty or unknown setting patches", (patch) => {
    expect(() => parseDatabaseConfigPatch(patch))
      .toThrow(DatabaseConfigValidationError);
  });

  test("quotes valid database names and rejects unsafe identifiers", () => {
    expect(quoteDatabaseIdentifier("supa_project-1")).toBe(
      '"supa_project-1"',
    );
    expect(() => quoteDatabaseIdentifier('supa_bad" RESET ALL --'))
      .toThrow("Invalid PostgreSQL database identifier");
    expect(() => quoteDatabaseIdentifier("x".repeat(64)))
      .toThrow("Invalid PostgreSQL database identifier");
  });
});

describe("project database config live reads", () => {
  test("returns PostgreSQL context and pending_restart without defaults", async () => {
    const database = {
      unsafe: mock(async () => [{
        name: "statement_timeout",
        setting: "2500",
        unit: "ms",
        context: "user",
        pending_restart: false,
      }]),
    };

    const settings = await readLiveDatabaseSettings(database);

    expect(settings).toEqual([{
      name: "statement_timeout",
      setting: "2500",
      unit: "ms",
      context: "user",
      pending_restart: false,
    }]);
    expect(liveSettingNumber(settings, "statement_timeout")).toBe(2500);
    expect(liveSettingNumber(settings, "max_connections")).toBeNull();
  });
});

describe("project database config updates", () => {
  test("applies only request fields before persistence", async () => {
    const events: string[] = [];
    const database = {
      unsafe: mock(async (query: string) => {
        events.push(query.includes("pg_db_role_setting") ? "read-overrides" : query.trim());
        return [];
      }),
    };

    const update = await updateDatabaseSettings({
      database,
      databaseName: "supa_project_1",
      patch: { statement_timeout: 5000 },
      persist: async () => {
        events.push("persist");
        return { database: { statement_timeout: 5000 } };
      },
    });

    expect(update.ok).toBe(true);
    expect(events).toEqual([
      "read-overrides",
      'ALTER DATABASE "supa_project_1" SET statement_timeout = 5000',
      "persist",
    ]);
    expect(events.join("\n")).not.toContain(
      "idle_in_transaction_session_timeout =",
    );
  });

  test("does not persist and restores already-applied fields after apply failure", async () => {
    const statements: string[] = [];
    const persist = mock(async () => ({}));
    const database = {
      unsafe: mock(async (query: string) => {
        if (query.includes("pg_db_role_setting")) return [];
        statements.push(query);
        if (query.includes("idle_in_transaction_session_timeout = 20")) {
          throw new Error("database rejected setting");
        }
        return [];
      }),
    };

    const update = await updateDatabaseSettings({
      database,
      databaseName: "supa_project_1",
      patch: {
        statement_timeout: 10,
        idle_in_transaction_session_timeout: 20,
      },
      persist,
    });

    expect(update).toMatchObject({ ok: false, stage: "apply" });
    expect(persist).not.toHaveBeenCalled();
    expect(statements).toEqual([
      'ALTER DATABASE "supa_project_1" SET statement_timeout = 10',
      'ALTER DATABASE "supa_project_1" SET idle_in_transaction_session_timeout = 20',
      'ALTER DATABASE "supa_project_1" RESET statement_timeout',
      'ALTER DATABASE "supa_project_1" RESET idle_in_transaction_session_timeout',
    ]);
  });

  test("persists PgBouncer metadata without reading or mutating PostgreSQL", async () => {
    const database = { unsafe: mock(async () => []) };
    const persist = mock(async () => ({
      database: { pgbouncer_enabled: true },
    }));

    const update = await updateDatabaseSettings({
      database,
      databaseName: "supa_project_1",
      patch: { pgbouncer_enabled: true },
      persist,
    });

    expect(update.ok).toBe(true);
    expect(database.unsafe).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledTimes(1);
  });

  test("rejects an unsafe database identifier before SQL or persistence", async () => {
    const database = { unsafe: mock(async () => []) };
    const persist = mock(async () => ({}));

    const update = await updateDatabaseSettings({
      database,
      databaseName: 'supa_bad" RESET ALL --',
      patch: { statement_timeout: 1000 },
      persist,
    });

    expect(update).toMatchObject({
      ok: false,
      stage: "apply",
      restoreAttempted: false,
    });
    expect(database.unsafe).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  test("restores the prior database-level override after persistence failure", async () => {
    const statements: string[] = [];
    const database = {
      unsafe: mock(async (query: string) => {
        if (query.includes("pg_db_role_setting")) {
          return [{ name: "statement_timeout", setting: "2s" }];
        }
        statements.push(query);
        return [];
      }),
    };

    const update = await updateDatabaseSettings({
      database,
      databaseName: "supa_project_1",
      patch: { statement_timeout: 1000 },
      persist: async () => {
        throw new Error("metadata unavailable");
      },
    });

    expect(update).toMatchObject({
      ok: false,
      stage: "persist",
      restoreFailures: [],
    });
    expect(statements).toEqual([
      'ALTER DATABASE "supa_project_1" SET statement_timeout = 1000',
      'ALTER DATABASE "supa_project_1" SET statement_timeout = \'2s\'',
    ]);
  });

  test("reports restoration failures explicitly", async () => {
    const database = {
      unsafe: mock(async (query: string) => {
        if (query.includes("pg_db_role_setting")) return [];
        if (query.includes(" RESET ")) throw new Error("restore failed");
        return [];
      }),
    };

    const update = await updateDatabaseSettings({
      database,
      databaseName: "supa_project_1",
      patch: { statement_timeout: 1000 },
      persist: async () => {
        throw new Error("metadata unavailable");
      },
    });

    expect(update).toMatchObject({
      ok: false,
      stage: "persist",
      restoreFailures: [{ name: "statement_timeout" }],
    });
  });
});
