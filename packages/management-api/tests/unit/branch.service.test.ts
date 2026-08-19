import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";

import { branchService } from "../../src/services/branch.service";
import { sql } from "../../src/db";
import { databaseService } from "../../src/services/database.service";
import { tenantRuntimeService } from "../../src/services/tenant-runtime.service";
import { projectRepository } from "../../src/repositories/project.repository";
import { branchReplacementJournal } from "../../src/services/branch-replacement-journal";
import {
  buildBranchMigrationPromotionPlan,
  createMigrationLedgerEntry,
  summarizeMigrationLedgerEntry,
} from "../../src/services/migration-promotion";

type SpawnInvocation = {
  cmd: string[];
  env?: Record<string, string | undefined>;
  stdin?: unknown;
};

function fakeSubprocess(options: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
  return {
    exited: Promise.resolve(options.exitCode ?? 0),
    stdout: new Response(options.stdout ?? "").body,
    stderr: new Response(options.stderr ?? "").body,
  } as unknown as ReturnType<typeof Bun.spawn>;
}

describe("branchService", () => {
  afterEach(() => {
    // bun:test restores spies individually; keep cleanup explicit for this service-level test.
  });

  test("createBranch restores into an empty database instead of pre-applying the tenant schema", async () => {
    const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue({
      ref: "parent",
      name: "Parent Project",
      db_password: "parent-password",
      jwt_secret: "jwt-secret",
      anon_key: "anon-key",
      service_role_key: "service-role-key",
      region: "local",
      config: {},
    } as never);
    const createProjectSpy = spyOn(projectRepository, "create").mockResolvedValue({ ref: "branch" } as never);
    const createDatabaseSpy = spyOn(databaseService, "createDatabase").mockResolvedValue({ success: true });
    const restartSpy = spyOn(tenantRuntimeService, "restartRuntime").mockResolvedValue({ success: true } as never);

    const service = branchService as unknown as {
      withBranchProvisionLock(
        input: { parentRef: string; branchRef: string },
        operation: () => Promise<void>,
      ): Promise<void>;
      createEmptyTenantDatabase(): Promise<void>;
      cloneDatabase(): Promise<void>;
      copyMigrationLedgerHistory(): Promise<void>;
      applyRuntimeGrants(): Promise<void>;
      prepareMigrationDatabaseRole(): Promise<void>;
    };
    const lockSpy = spyOn(service, "withBranchProvisionLock").mockImplementation(async (_input, operation) => operation());
    const createEmptySpy = spyOn(service, "createEmptyTenantDatabase").mockResolvedValue(undefined);
    const cloneSpy = spyOn(service, "cloneDatabase").mockResolvedValue(undefined);
    const copyLedgerSpy = spyOn(service, "copyMigrationLedgerHistory").mockResolvedValue(undefined);
    const grantsSpy = spyOn(service, "applyRuntimeGrants").mockResolvedValue(undefined);
    const prepareRoleSpy = spyOn(service, "prepareMigrationDatabaseRole").mockResolvedValue(undefined);

    try {
      await branchService.createBranch({ parentRef: "parent", branchRef: "branch", name: "feature-x" });

      expect(createProjectSpy).toHaveBeenCalledTimes(1);
      expect(lockSpy).toHaveBeenCalledTimes(1);
      expect(lockSpy.mock.calls[0]?.[0]).toEqual({ parentRef: "parent", branchRef: "branch" });
      expect(createEmptySpy).toHaveBeenCalledTimes(1);
      expect(cloneSpy).toHaveBeenCalledWith("supa_parent", "supa_branch", "schema_only");
      expect(copyLedgerSpy).toHaveBeenCalledWith("supa_parent", "supa_branch");
      expect(grantsSpy).toHaveBeenCalledTimes(1);
      expect(prepareRoleSpy).toHaveBeenCalledTimes(1);
      expect(createDatabaseSpy).not.toHaveBeenCalled();
      expect(restartSpy).toHaveBeenCalledWith("branch");
    } finally {
      findSpy.mockRestore();
      createProjectSpy.mockRestore();
      createDatabaseSpy.mockRestore();
      restartSpy.mockRestore();
      lockSpy.mockRestore();
      createEmptySpy.mockRestore();
      cloneSpy.mockRestore();
      copyLedgerSpy.mockRestore();
      grantsSpy.mockRestore();
      prepareRoleSpy.mockRestore();
    }
  });

  test("createBranch keeps full data cloning explicit and does not rewrite its copied ledger", async () => {
    const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue({
      ref: "parent",
      name: "Parent Project",
      db_password: "parent-password",
      jwt_secret: "jwt-secret",
      anon_key: "anon-key",
      service_role_key: "service-role-key",
      region: "local",
      config: {},
    } as never);
    const createProjectSpy = spyOn(projectRepository, "create").mockResolvedValue({ ref: "branch" } as never);
    const restartSpy = spyOn(tenantRuntimeService, "restartRuntime").mockResolvedValue({ success: true } as never);
    const service = branchService as unknown as {
      withBranchProvisionLock(
        input: { parentRef: string; branchRef: string },
        operation: () => Promise<void>,
      ): Promise<void>;
      createEmptyTenantDatabase(): Promise<void>;
      cloneDatabase(): Promise<void>;
      copyMigrationLedgerHistory(): Promise<void>;
      applyRuntimeGrants(): Promise<void>;
      prepareMigrationDatabaseRole(): Promise<void>;
    };
    const lockSpy = spyOn(service, "withBranchProvisionLock").mockImplementation(async (_input, operation) => operation());
    const createEmptySpy = spyOn(service, "createEmptyTenantDatabase").mockResolvedValue(undefined);
    const cloneSpy = spyOn(service, "cloneDatabase").mockResolvedValue(undefined);
    const copyLedgerSpy = spyOn(service, "copyMigrationLedgerHistory").mockResolvedValue(undefined);
    const grantsSpy = spyOn(service, "applyRuntimeGrants").mockResolvedValue(undefined);
    const prepareRoleSpy = spyOn(service, "prepareMigrationDatabaseRole").mockResolvedValue(undefined);

    try {
      await branchService.createBranch({
        parentRef: "parent",
        branchRef: "branch",
        name: "debug-production-data",
        dataMode: "full_clone",
      });

      expect(cloneSpy).toHaveBeenCalledWith("supa_parent", "supa_branch", "full_clone");
      expect(copyLedgerSpy).not.toHaveBeenCalled();
      expect(lockSpy).toHaveBeenCalledTimes(1);
    } finally {
      findSpy.mockRestore();
      createProjectSpy.mockRestore();
      restartSpy.mockRestore();
      lockSpy.mockRestore();
      createEmptySpy.mockRestore();
      cloneSpy.mockRestore();
      copyLedgerSpy.mockRestore();
      grantsSpy.mockRestore();
      prepareRoleSpy.mockRestore();
    }
  });

  test("promoteBranch applies migration ledger entries without cloning branch data", async () => {
    const entry = createMigrationLedgerEntry({
      version: "202607180001",
      name: "add_accounts",
      statements: ["create table accounts(id bigint primary key);"],
    });
    const initialPlan = buildBranchMigrationPromotionPlan({
      parentRef: "parent",
      branchRef: "branch",
      parent: [],
      branch: [entry],
    });
    const completedPlan = buildBranchMigrationPromotionPlan({
      parentRef: "parent",
      branchRef: "branch",
      parent: [entry],
      branch: [entry],
    });
    const service = branchService as unknown as {
      withPromotionLock(
        input: { parentRef: string; branchRef: string },
        operation: () => Promise<unknown>,
      ): Promise<unknown>;
      buildPromotionState(parentRef: string, branchRef: string, connection?: never): Promise<{
        plan: typeof initialPlan;
        pendingEntries: Array<typeof entry>;
      }>;
      applyMigrationBatch(parentRef: string, entries: ReadonlyArray<typeof entry>): Promise<Array<ReturnType<typeof summarizeMigrationLedgerEntry>>>;
      cloneDatabase(sourceDb: string, targetDb: string, dataMode?: "schema_only" | "full_clone"): Promise<void>;
    };
    const lockSpy = spyOn(service, "withPromotionLock").mockImplementation(
      async (_input, operation) => operation(),
    );
    const stateSpy = spyOn(service, "buildPromotionState")
      .mockResolvedValueOnce({ plan: initialPlan, pendingEntries: [entry] })
      .mockResolvedValueOnce({ plan: completedPlan, pendingEntries: [] });
    const applySpy = spyOn(service, "applyMigrationBatch").mockResolvedValue([summarizeMigrationLedgerEntry(entry)]);
    const cloneSpy = spyOn(service, "cloneDatabase").mockResolvedValue(undefined);

    try {
      const result = await branchService.promoteBranch({
        parentRef: "parent",
        branchRef: "branch",
        expectedPlanChecksum: initialPlan.plan_checksum,
      });

      expect(result.applied).toEqual([summarizeMigrationLedgerEntry(entry)]);
      expect(applySpy).toHaveBeenCalledWith("parent", [entry]);
      expect(cloneSpy).not.toHaveBeenCalled();
    } finally {
      lockSpy.mockRestore();
      stateSpy.mockRestore();
      applySpy.mockRestore();
      cloneSpy.mockRestore();
    }
  });

  test("queues schema reload inside each promoted migration transaction", async () => {
    const entry = createMigrationLedgerEntry({
      version: "20260819091000",
      name: "create_reload_probe",
      statements: ["CREATE TABLE reload_probe(id bigint primary key)"],
    });
    const transactionCalls: Array<{ text: string; values: unknown[] }> = [];
    const transaction = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        transactionCalls.push({ text: strings.join("?"), values });
        return Promise.resolve([]);
      },
      {
        array: (values: readonly string[]) => values,
        unsafe: async () => [],
      },
    );
    const connection = {
      begin: async (operation: (tx: typeof transaction) => Promise<void>) => operation(transaction),
    };
    const adminDb = ((strings: TemplateStringsArray) => Promise.resolve([])) as any;
    const service = branchService as unknown as {
      applyMigrationEntry(
        connection: typeof connection,
        adminDb: typeof adminDb,
        parentRef: string,
        entry: typeof entry,
      ): Promise<void>;
    };

    await service.applyMigrationEntry(connection, adminDb, "parent", entry);

    const recordIndex = transactionCalls.findIndex(({ text }) => text.includes("record_schema_migration"));
    const notifyIndex = transactionCalls.findIndex(({ text, values }) =>
      text.includes("pg_notify") && values.includes("pgrst_parent")
    );
    expect(recordIndex).toBeGreaterThan(-1);
    expect(notifyIndex).toBeGreaterThan(recordIndex);
  });

  test("promoteBranch rejects a stale reviewed plan before applying SQL", async () => {
    const entry = createMigrationLedgerEntry({
      version: "202607180001",
      name: "add_accounts",
      statements: ["create table accounts(id bigint primary key);"],
    });
    const plan = buildBranchMigrationPromotionPlan({
      parentRef: "parent",
      branchRef: "branch",
      parent: [],
      branch: [entry],
    });
    const service = branchService as unknown as {
      withPromotionLock(
        input: { parentRef: string; branchRef: string },
        operation: () => Promise<unknown>,
      ): Promise<unknown>;
      buildPromotionState(parentRef: string, branchRef: string, connection?: never): Promise<{
        plan: typeof plan;
        pendingEntries: Array<typeof entry>;
      }>;
      applyMigrationBatch(parentRef: string, entries: ReadonlyArray<typeof entry>): Promise<Array<ReturnType<typeof summarizeMigrationLedgerEntry>>>;
    };
    const lockSpy = spyOn(service, "withPromotionLock").mockImplementation(
      async (_input, operation) => operation(),
    );
    const stateSpy = spyOn(service, "buildPromotionState").mockResolvedValue({ plan, pendingEntries: [entry] });
    const applySpy = spyOn(service, "applyMigrationBatch").mockResolvedValue([]);

    try {
      await expect(branchService.promoteBranch({
        parentRef: "parent",
        branchRef: "branch",
        expectedPlanChecksum: "0".repeat(64),
      })).rejects.toMatchObject({ code: "promotion_plan_changed" });
      expect(applySpy).not.toHaveBeenCalled();
    } finally {
      lockSpy.mockRestore();
      stateSpy.mockRestore();
      applySpy.mockRestore();
    }
  });

  test("promoteBranch preserves applied evidence when ledger read-back fails", async () => {
    const entry = createMigrationLedgerEntry({
      version: "202607180001",
      name: "add_accounts",
      statements: ["create table accounts(id bigint primary key);"],
    });
    const plan = buildBranchMigrationPromotionPlan({
      parentRef: "parent",
      branchRef: "branch",
      parent: [],
      branch: [entry],
    });
    const applied = [summarizeMigrationLedgerEntry(entry)];
    const service = branchService as unknown as {
      withPromotionLock(
        input: { parentRef: string; branchRef: string },
        operation: () => Promise<unknown>,
      ): Promise<unknown>;
      buildPromotionState(parentRef: string, branchRef: string): Promise<{
        plan: typeof plan;
        pendingEntries: Array<typeof entry>;
      }>;
      applyMigrationBatch(parentRef: string, entries: ReadonlyArray<typeof entry>): Promise<typeof applied>;
    };
    const lockSpy = spyOn(service, "withPromotionLock").mockImplementation(async (_input, operation) => operation());
    const stateSpy = spyOn(service, "buildPromotionState")
      .mockResolvedValueOnce({ plan, pendingEntries: [entry] })
      .mockRejectedValueOnce(new Error("branch ledger unavailable"));
    const applySpy = spyOn(service, "applyMigrationBatch").mockResolvedValue(applied);

    try {
      await expect(branchService.promoteBranch({
        parentRef: "parent",
        branchRef: "branch",
        expectedPlanChecksum: plan.plan_checksum,
      })).rejects.toMatchObject({
        code: "promotion_readback_failed",
        applied,
      });
    } finally {
      lockSpy.mockRestore();
      stateSpy.mockRestore();
      applySpy.mockRestore();
    }
  });

  test("migration ledger reads fail closed on connectivity or permission errors", async () => {
    const service = branchService as unknown as {
      readMigrationLedger(database: { unsafe(query: string): Promise<unknown[]> }): Promise<unknown[]>;
    };
    const connectionError = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const database = {
      unsafe: async () => { throw connectionError; },
    };

    await expect(service.readMigrationLedger(database)).rejects.toBe(connectionError);
  });

  test("whole-database replacement reports committed state when runtime recovery is unhealthy", async () => {
    const findSpy = spyOn(projectRepository, "findByRef").mockResolvedValue({
      ref: "parent",
      db_name: "supa_parent",
      db_user: "role_parent",
      db_password: "parent-password",
    } as never);
    const service = branchService as unknown as {
      replaceParentDatabaseUnderLock(input: { parentRef: string; branchRef: string }): Promise<unknown>;
      createEmptyTenantDatabase(): Promise<void>;
      cloneDatabase(): Promise<void>;
      applyRuntimeGrants(): Promise<void>;
      validateRestoredDatabase(): Promise<void>;
      terminateDatabaseConnections(): Promise<void>;
    };
    const createSpy = spyOn(service, "createEmptyTenantDatabase").mockResolvedValue(undefined);
    const cloneSpy = spyOn(service, "cloneDatabase").mockResolvedValue(undefined);
    const grantsSpy = spyOn(service, "applyRuntimeGrants").mockResolvedValue(undefined);
    const validateSpy = spyOn(service, "validateRestoredDatabase").mockResolvedValue(undefined);
    const terminateSpy = spyOn(service, "terminateDatabaseConnections").mockResolvedValue(undefined);
    const journalGetSpy = spyOn(branchReplacementJournal, "get").mockResolvedValue(null);
    const journalBeginSpy = spyOn(branchReplacementJournal, "begin").mockResolvedValue(undefined);
    const journalPhaseSpy = spyOn(branchReplacementJournal, "setPhase").mockResolvedValue(undefined);
    const journalRemoveSpy = spyOn(branchReplacementJournal, "remove").mockResolvedValue(undefined);
    const stopSpy = spyOn(tenantRuntimeService, "stopRuntime").mockResolvedValue(undefined);
    const restartSpy = spyOn(tenantRuntimeService, "restartRuntime").mockResolvedValue({
      status: "error",
      health: "unhealthy",
      port: 3000,
      gotruePort: 3001,
    });
    const unsafeSpy = spyOn(sql, "unsafe").mockResolvedValue([] as never);

    try {
      await expect(service.replaceParentDatabaseUnderLock({ parentRef: "parent", branchRef: "branch" }))
        .rejects.toMatchObject({
          code: "replacement_runtime_unavailable",
          replacementCommitted: true,
          backupDatabase: expect.stringContaining("supa_parent_backup_"),
        });
    } finally {
      findSpy.mockRestore();
      createSpy.mockRestore();
      cloneSpy.mockRestore();
      grantsSpy.mockRestore();
      validateSpy.mockRestore();
      terminateSpy.mockRestore();
      journalGetSpy.mockRestore();
      journalBeginSpy.mockRestore();
      journalPhaseSpy.mockRestore();
      journalRemoveSpy.mockRestore();
      stopSpy.mockRestore();
      restartSpy.mockRestore();
      unsafeSpy.mockRestore();
    }
  });

  test("whole-database replacement marks manual recovery when rollback cannot restore the parent name", async () => {
    const service = branchService as unknown as {
      switchParentDatabase(
        parentRef: string,
        names: { parentDb: string; branchDb: string; tempDb: string; backupDb: string },
      ): Promise<void>;
      setDatabaseConnectionsAllowed(dbName: string, allowed: boolean): Promise<void>;
      terminateDatabaseConnections(dbName: string): Promise<void>;
      renameDatabase(source: string, target: string): Promise<void>;
      restoreParentDatabaseName(): Promise<boolean>;
      dropDatabaseWithWarning(): Promise<void>;
      restartParentRuntimeBestEffort(): Promise<void>;
    };
    const names = {
      parentDb: "supa_parent",
      branchDb: "supa_branch",
      tempDb: "supa_parent_promote_1",
      backupDb: "supa_parent_backup_1",
    };
    const stopSpy = spyOn(tenantRuntimeService, "stopRuntime").mockResolvedValue(undefined);
    const journalPhaseSpy = spyOn(branchReplacementJournal, "setPhase").mockResolvedValue(undefined);
    const journalRemoveSpy = spyOn(branchReplacementJournal, "remove").mockResolvedValue(undefined);
    const allowSpy = spyOn(service, "setDatabaseConnectionsAllowed").mockResolvedValue(undefined);
    const terminateSpy = spyOn(service, "terminateDatabaseConnections").mockResolvedValue(undefined);
    const renameSpy = spyOn(service, "renameDatabase")
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("rename temp failed"));
    const restoreSpy = spyOn(service, "restoreParentDatabaseName").mockResolvedValue(false);
    const dropSpy = spyOn(service, "dropDatabaseWithWarning").mockResolvedValue(undefined);
    const restartSpy = spyOn(service, "restartParentRuntimeBestEffort").mockResolvedValue(undefined);

    try {
      await expect(service.switchParentDatabase("parent", names)).rejects.toMatchObject({
        code: "replacement_switch_failed",
        replacementCommitted: false,
        recoveryRequired: true,
        backupDatabase: names.backupDb,
        recoveryDatabase: names.backupDb,
      });
    } finally {
      stopSpy.mockRestore();
      journalPhaseSpy.mockRestore();
      journalRemoveSpy.mockRestore();
      allowSpy.mockRestore();
      terminateSpy.mockRestore();
      renameSpy.mockRestore();
      restoreSpy.mockRestore();
      dropSpy.mockRestore();
      restartSpy.mockRestore();
    }
  });

  test("whole-database replacement reports committed state when the final journal phase write fails", async () => {
    const service = branchService as unknown as {
      switchParentDatabase(
        parentRef: string,
        names: { parentDb: string; branchDb: string; tempDb: string; backupDb: string },
      ): Promise<void>;
      setDatabaseConnectionsAllowed(dbName: string, allowed: boolean): Promise<void>;
      terminateDatabaseConnections(dbName: string): Promise<void>;
      renameDatabase(source: string, target: string): Promise<void>;
      restartParentRuntimeAndVerify(parentRef: string, parentDb: string): Promise<void>;
    };
    const names = {
      parentDb: "supa_parent",
      branchDb: "supa_branch",
      tempDb: "supa_parent_promote_1",
      backupDb: "supa_parent_backup_1",
    };
    let phaseWrites = 0;
    const journalPhaseSpy = spyOn(branchReplacementJournal, "setPhase").mockImplementation(async () => {
      phaseWrites += 1;
      if (phaseWrites === 3) throw new Error("control database unavailable");
    });
    const stopSpy = spyOn(tenantRuntimeService, "stopRuntime").mockResolvedValue(undefined);
    const allowSpy = spyOn(service, "setDatabaseConnectionsAllowed").mockResolvedValue(undefined);
    const terminateSpy = spyOn(service, "terminateDatabaseConnections").mockResolvedValue(undefined);
    const renameSpy = spyOn(service, "renameDatabase").mockResolvedValue(undefined);
    const restartSpy = spyOn(service, "restartParentRuntimeAndVerify").mockResolvedValue(undefined);

    try {
      await expect(service.switchParentDatabase("parent", names)).rejects.toMatchObject({
        code: "replacement_switch_failed",
        replacementCommitted: true,
        recoveryRequired: true,
        backupDatabase: names.backupDb,
        recoveryDatabase: names.backupDb,
      });
      expect(renameSpy).toHaveBeenCalledTimes(2);
      expect(restartSpy).toHaveBeenCalledWith("parent", "supa_parent");
    } finally {
      journalPhaseSpy.mockRestore();
      stopSpy.mockRestore();
      allowSpy.mockRestore();
      terminateSpy.mockRestore();
      renameSpy.mockRestore();
      restartSpy.mockRestore();
    }
  });

  test("replacement journal recovery restores the old parent after a crash between database renames", async () => {
    const service = branchService as unknown as {
      recoverReplacementJournalEntry(entry: Record<string, unknown>): Promise<boolean>;
      databaseExists(dbName: string): Promise<boolean>;
      renameDatabase(source: string, target: string): Promise<void>;
      setDatabaseConnectionsAllowed(dbName: string, allowed: boolean): Promise<void>;
      dropDatabaseIfExists(dbName: string): Promise<void>;
      restartParentRuntimeAndVerify(parentRef: string, parentDb: string): Promise<void>;
    };
    const entry = {
      parent_ref: "parent",
      branch_ref: "branch",
      parent_db: "supa_parent",
      branch_db: "supa_branch",
      temp_db: "supa_parent_promote_1",
      backup_db: "supa_parent_backup_1",
      phase: "parent_renamed",
      recovery_database: "supa_parent_backup_1",
      updated_at: new Date().toISOString(),
    };
    const existsSpy = spyOn(service, "databaseExists")
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const renameSpy = spyOn(service, "renameDatabase").mockResolvedValue(undefined);
    const allowSpy = spyOn(service, "setDatabaseConnectionsAllowed").mockResolvedValue(undefined);
    const dropSpy = spyOn(service, "dropDatabaseIfExists").mockResolvedValue(undefined);
    const restartSpy = spyOn(service, "restartParentRuntimeAndVerify").mockResolvedValue(undefined);
    const journalRemoveSpy = spyOn(branchReplacementJournal, "remove").mockResolvedValue(undefined);

    try {
      await expect(service.recoverReplacementJournalEntry(entry)).resolves.toBe(true);
      expect(renameSpy).toHaveBeenCalledWith("supa_parent_backup_1", "supa_parent");
      expect(allowSpy).toHaveBeenCalledWith("supa_parent", true);
      expect(dropSpy).toHaveBeenCalledWith("supa_parent_promote_1");
      expect(restartSpy).toHaveBeenCalledWith("parent", "supa_parent");
      expect(journalRemoveSpy).toHaveBeenCalledWith("parent");
    } finally {
      existsSpy.mockRestore();
      renameSpy.mockRestore();
      allowSpy.mockRestore();
      dropSpy.mockRestore();
      restartSpy.mockRestore();
      journalRemoveSpy.mockRestore();
    }
  });

  test("replacement journal preserves committed state while runtime recovery is still pending", async () => {
    const service = branchService as unknown as {
      recoverExistingReplacement(parentRef: string): Promise<void>;
      databaseExists(dbName: string): Promise<boolean>;
      restartParentRuntimeAndVerify(parentRef: string, parentDb: string): Promise<void>;
    };
    const entry = {
      parent_ref: "parent",
      branch_ref: "branch",
      parent_db: "supa_parent",
      branch_db: "supa_branch",
      temp_db: "supa_parent_promote_1",
      backup_db: "supa_parent_backup_1",
      phase: "recovery_required" as const,
      replacement_committed: true,
      recovery_database: "supa_parent_backup_1",
      updated_at: new Date().toISOString(),
    };
    const journalGetSpy = spyOn(branchReplacementJournal, "get").mockResolvedValue(entry);
    const journalPhaseSpy = spyOn(branchReplacementJournal, "setPhase").mockResolvedValue(undefined);
    const existsSpy = spyOn(service, "databaseExists")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const restartSpy = spyOn(service, "restartParentRuntimeAndVerify").mockRejectedValue(new Error("unhealthy"));

    try {
      await expect(service.recoverExistingReplacement("parent")).rejects.toMatchObject({
        replacementCommitted: true,
        recoveryRequired: true,
        backupDatabase: "supa_parent_backup_1",
      });
    } finally {
      journalGetSpy.mockRestore();
      journalPhaseSpy.mockRestore();
      existsSpy.mockRestore();
      restartSpy.mockRestore();
    }
  });

  test("migration ledger reads treat genuinely absent compatibility tables as empty", async () => {
    const service = branchService as unknown as {
      readMigrationLedger(database: { unsafe(query: string): Promise<unknown[]> }): Promise<unknown[]>;
    };
    const missingTable = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    const database = {
      unsafe: async () => { throw missingTable; },
    };

    expect(await service.readMigrationLedger(database)).toEqual([]);
  });

  test("cloneDatabase keeps special-character credentials out of structured pg argv", async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const password = `p@#?/ '"$()`;
    process.env.DATABASE_URL = `postgresql://admin:${encodeURIComponent(password)}@db.internal:5432/control?sslmode=require`;
    const conflictingEnvironment = {
      PGPASSWORD: "stale-password",
      PGPASSFILE: "/tmp/stale.pgpass",
      PGSERVICE: "stale-service",
      PGSERVICEFILE: "/tmp/stale-service.conf",
      PGHOST: "attacker.invalid",
      PGPORT: "9999",
      PGUSER: "attacker",
      PGDATABASE: "attacker",
      PGOPTIONS: "-c role=attacker",
      PGSSLMODE: "disable",
      PGCONNECT_TIMEOUT: "1",
      PGAPPNAME: "attacker-app",
      PGSSLROOTCERT: "/tmp/attacker-ca.pem",
    } as const;
    const originalConflictingEnvironment = Object.fromEntries(
      Object.keys(conflictingEnvironment).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, conflictingEnvironment);

    const invocations: SpawnInvocation[] = [];
    const dump = fakeSubprocess({ stdout: "SELECT 1;" });
    const restore = fakeSubprocess();
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((options: SpawnInvocation) => {
      invocations.push(options);
      return invocations.length === 1 ? dump : restore;
    }) as typeof Bun.spawn);

    try {
      await (branchService as unknown as {
        cloneDatabase(sourceDb: string, targetDb: string): Promise<void>;
      }).cloneDatabase("supa_parent", "supa_branch");

      expect(invocations).toHaveLength(2);
      expect(invocations[0]?.cmd).toEqual([
        "pg_dump",
        "--no-owner",
        "--no-privileges",
        "--host", "db.internal",
        "--port", "5432",
        "--username", "admin",
        "--dbname", "supa_parent",
      ]);
      expect(invocations[1]?.cmd).toEqual([
        "psql",
        "--host", "db.internal",
        "--port", "5432",
        "--username", "admin",
        "--dbname", "supa_branch",
        "--set", "ON_ERROR_STOP=on",
        "--quiet",
      ]);
      expect(invocations[0]?.env?.PGPASSWORD).toBe(password);
      expect(invocations[1]?.env?.PGPASSWORD).toBe(password);
      expect(invocations[0]?.env?.PGSSLMODE).toBe("require");
      expect(invocations[0]?.env?.DATABASE_URL).toBeUndefined();
      expect(invocations[1]?.env?.DATABASE_URL).toBeUndefined();
      for (const key of Object.keys(conflictingEnvironment)) {
        if (key === "PGPASSWORD" || key === "PGSSLMODE") continue;
        expect(invocations[0]?.env?.[key]).toBeUndefined();
        expect(invocations[1]?.env?.[key]).toBeUndefined();
      }
      expect(invocations[1]?.stdin).toBe(dump.stdout);

      const serializedArgv = JSON.stringify(invocations.map(({ cmd }) => cmd));
      expect(serializedArgv).not.toContain(password);
      expect(serializedArgv).not.toContain(encodeURIComponent(password));
      expect(serializedArgv).not.toContain("postgresql://");
    } finally {
      spawnSpy.mockRestore();
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
      for (const [key, value] of Object.entries(originalConflictingEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("schema-only branch cloning passes pg_dump --schema-only", async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://admin:secret@db.internal:5432/control";
    const invocations: SpawnInvocation[] = [];
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((options: SpawnInvocation) => {
      invocations.push(options);
      return invocations.length === 1 ? fakeSubprocess({ stdout: "SELECT 1;" }) : fakeSubprocess();
    }) as typeof Bun.spawn);

    try {
      await (branchService as unknown as {
        cloneDatabase(sourceDb: string, targetDb: string, dataMode: "schema_only"): Promise<void>;
      }).cloneDatabase("supa_parent", "supa_branch", "schema_only");

      expect(invocations[0]?.cmd).toContain("--schema-only");
    } finally {
      spawnSpy.mockRestore();
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  test("cloneDatabase fails closed for malformed or incomplete DATABASE_URL values", async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const invalidUrls = [
      "not-a-url",
      "https://admin:secret@db.internal:5432/control",
      "postgresql://admin@db.internal:5432/control",
      "postgresql://:secret@db.internal:5432/control",
      "postgresql://admin:secret@db.internal:5432/",
      "postgresql://admin:secret@db.internal:0/control",
      "postgresql://admin:secret@db.internal:5432/control\rPGPASSWORD=attacker",
      `postgresql://admin:${"p".repeat(1_025)}@db.internal:5432/control`,
      "postgresql://admin:secret@db.internal:5432/control?sslmode=require%0APGHOST=attacker",
    ];
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => {
      throw new Error("subprocess must not start for an invalid DATABASE_URL");
    }) as typeof Bun.spawn);

    try {
      for (const invalidUrl of invalidUrls) {
        process.env.DATABASE_URL = invalidUrl;
        await expect((branchService as unknown as {
          cloneDatabase(sourceDb: string, targetDb: string): Promise<void>;
        }).cloneDatabase("supa_parent", "supa_branch")).rejects.toThrow("DATABASE_URL");
      }
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  test("cloneDatabase fails on either pipeline process and bounds redacted diagnostics", async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const password = `admin@#?/ '"$()`;
    const encodedPassword = encodeURIComponent(password);
    process.env.DATABASE_URL = `postgresql://admin:${encodedPassword}@db.internal:5432/control`;

    let subprocesses: ReturnType<typeof Bun.spawn>[] = [];
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => {
      const next = subprocesses.shift();
      if (!next) throw new Error("unexpected Bun.spawn call");
      return next;
    }) as typeof Bun.spawn);

    try {
      for (const scenario of [
        { label: "pg_dump", dumpExit: 9, restoreExit: 0 },
        { label: "psql", dumpExit: 0, restoreExit: 7 },
      ]) {
        const noisySecret = `${password}:${encodedPassword}:${"x".repeat(20_000)}`;
        subprocesses = [
          fakeSubprocess({ exitCode: scenario.dumpExit, stdout: "SELECT 1;", stderr: scenario.dumpExit ? noisySecret : "" }),
          fakeSubprocess({ exitCode: scenario.restoreExit, stderr: scenario.restoreExit ? noisySecret : "" }),
        ];

        const rejection = (branchService as unknown as {
          cloneDatabase(sourceDb: string, targetDb: string): Promise<void>;
        }).cloneDatabase("supa_parent", "supa_branch");
        try {
          await rejection;
          throw new Error("expected cloneDatabase to reject");
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          expect(message).toContain(`${scenario.label} exited with code`);
          expect(message).not.toContain(password);
          expect(message).not.toContain(encodedPassword);
          expect(message).toContain("[output truncated]");
          expect(message.length).toBeLessThanOrEqual(4_500);
        }
      }
    } finally {
      spawnSpy.mockRestore();
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  test("applyRuntimeGrants sends SQL on stdin without repeating role passwords in argv", async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const adminPassword = `admin @/#?'"$()`;
    const tenantPassword = `tenant @/#?'"$()`;
    process.env.DATABASE_URL = `postgresql://postgres:${encodeURIComponent(adminPassword)}@db.internal:5432/control`;

    let invocation: SpawnInvocation | undefined;
    const stderr = `${adminPassword}:${encodeURIComponent(adminPassword)}:${tenantPassword}:${encodeURIComponent(tenantPassword)}:${"z".repeat(20_000)}`;
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((options: SpawnInvocation) => {
      invocation = options;
      return fakeSubprocess({ exitCode: 6, stderr });
    }) as typeof Bun.spawn);

    try {
      let message = "";
      try {
        await (branchService as unknown as {
          applyRuntimeGrants(dbName: string, projectRef: string, password: string): Promise<void>;
        }).applyRuntimeGrants("supa_branch", "branch", tenantPassword);
        throw new Error("expected applyRuntimeGrants to reject");
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(invocation?.cmd).toEqual([
        "psql",
        "--host", "db.internal",
        "--port", "5432",
        "--username", "postgres",
        "--dbname", "supa_branch",
        "--set", "ON_ERROR_STOP=on",
        "--quiet",
      ]);
      expect(invocation?.env?.PGPASSWORD).toBe(adminPassword);
      const serializedArgv = JSON.stringify(invocation?.cmd ?? []);
      expect(serializedArgv).not.toContain(adminPassword);
      expect(serializedArgv).not.toContain(tenantPassword);
      expect(serializedArgv).not.toContain("postgresql://");
      expect(serializedArgv).not.toContain("--command");

      expect(invocation?.stdin).toBeInstanceOf(Blob);
      const sqlText = await (invocation?.stdin as Blob).text();
      expect(sqlText).toContain("GRANT anon, authenticated, service_role");
      expect(sqlText).not.toContain("ALTER ROLE");
      expect(sqlText).not.toContain(tenantPassword);

      expect(message).toContain("apply runtime grants failed");
      expect(message).toContain("psql exited with code 6");
      expect(message).not.toContain(adminPassword);
      expect(message).not.toContain(encodeURIComponent(adminPassword));
      expect(message).not.toContain(tenantPassword);
      expect(message).not.toContain(encodeURIComponent(tenantPassword));
      expect(message).toContain("[output truncated]");
      expect(message.length).toBeLessThanOrEqual(4_500);
    } finally {
      spawnSpy.mockRestore();
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  test("createEmptyTenantDatabase sends only a client-generated SCRAM verifier to unsafe SQL", async () => {
    const password = `tenant-plain @/#?'"$()-must-never-enter-sql`;
    const service = branchService as unknown as {
      databaseExists(dbName: string): Promise<boolean>;
      executeUnsafeSql(statement: string): Promise<void>;
      createEmptyTenantDatabase(dbName: string, projectRef: string, password: string): Promise<void>;
    };
    const databaseExistsSpy = spyOn(service, "databaseExists").mockResolvedValue(false);
    const statements: string[] = [];
    const unsafeSpy = spyOn(service, "executeUnsafeSql").mockImplementation(async (statement: string) => {
      statements.push(statement);
    });

    try {
      await service.createEmptyTenantDatabase("supa_branch", "branch", password);

      const roleSql = statements.find((statement) => statement.includes("CREATE ROLE"));
      expect(roleSql).toBeDefined();
      expect(roleSql).not.toContain(password);
      expect(roleSql).not.toContain(encodeURIComponent(password));
      expect(roleSql?.match(/PASSWORD/g)).toHaveLength(4);
      expect(roleSql?.match(/SCRAM-SHA-256/g)).toHaveLength(4);

      const verifierMatch = roleSql?.match(
        /SCRAM-SHA-256\$4096:([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)/,
      );
      expect(verifierMatch).not.toBeNull();
      const [, saltBase64, storedKeyBase64, serverKeyBase64] = verifierMatch ?? [];
      const saltedPassword = pbkdf2Sync(password, Buffer.from(saltBase64 ?? "", "base64"), 4_096, 32, "sha256");
      const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
      const expectedStoredKey = createHash("sha256").update(clientKey).digest("base64");
      const expectedServerKey = createHmac("sha256", saltedPassword).update("Server Key").digest("base64");
      expect(storedKeyBase64).toBe(expectedStoredKey);
      expect(serverKeyBase64).toBe(expectedServerKey);
    } finally {
      unsafeSpy.mockRestore();
      databaseExistsSpy.mockRestore();
    }
  });

  test("PostgreSQL diagnostics redact secrets across the capture boundary and stay within 4096 UTF-8 bytes", async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const adminPassword = "ADMIN-BOUNDARY-SECRET-@/#?$()";
    const tenantPassword = "TENANT-BOUNDARY-SECRET-@/#?$()";
    process.env.DATABASE_URL = `postgresql://postgres:${encodeURIComponent(adminPassword)}@db.internal:5432/control`;

    let subprocesses: ReturnType<typeof Bun.spawn>[] = [];
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => {
      const next = subprocesses.shift();
      if (!next) throw new Error("unexpected Bun.spawn call");
      return next;
    }) as typeof Bun.spawn);

    try {
      subprocesses = [
        fakeSubprocess({
          exitCode: 9,
          stdout: "SELECT 1;",
          stderr: `${"界".repeat(1_362)}${adminPassword}${"x".repeat(8_000)}`,
        }),
        fakeSubprocess(),
      ];
      let cloneMessage = "";
      try {
        await (branchService as unknown as {
          cloneDatabase(sourceDb: string, targetDb: string): Promise<void>;
        }).cloneDatabase("supa_parent", "supa_branch");
      } catch (error: unknown) {
        cloneMessage = error instanceof Error ? error.message : String(error);
      }

      expect(cloneMessage).not.toContain(adminPassword);
      expect(cloneMessage).not.toContain(adminPassword.slice(0, 8));
      expect(new TextEncoder().encode(cloneMessage).byteLength).toBeLessThanOrEqual(4_096);
      expect(cloneMessage).toContain("[output truncated]");

      subprocesses = [
        fakeSubprocess({
          exitCode: 7,
          stderr: `${"界".repeat(1_362)}${encodeURIComponent(tenantPassword)}${"y".repeat(8_000)}`,
        }),
      ];
      let grantsMessage = "";
      try {
        await (branchService as unknown as {
          applyRuntimeGrants(dbName: string, projectRef: string, password: string): Promise<void>;
        }).applyRuntimeGrants("supa_branch", "branch", tenantPassword);
      } catch (error: unknown) {
        grantsMessage = error instanceof Error ? error.message : String(error);
      }

      expect(grantsMessage).not.toContain(tenantPassword);
      expect(grantsMessage).not.toContain(encodeURIComponent(tenantPassword));
      expect(grantsMessage).not.toContain(encodeURIComponent(tenantPassword).slice(0, 8));
      expect(new TextEncoder().encode(grantsMessage).byteLength).toBeLessThanOrEqual(4_096);
      expect(grantsMessage).toContain("[output truncated]");
    } finally {
      spawnSpy.mockRestore();
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });
});
