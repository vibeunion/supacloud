import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertExpectedControlPlaneDatabaseIdentity,
  controlPlaneDatabaseFingerprint,
  inspectControlPlaneDatabaseIdentity,
  parseExpectedControlPlaneDatabaseFingerprint,
  parseExpectedControlPlaneDatabaseSnapshot,
  withExpectedControlPlaneDatabaseTransaction,
  type ControlPlaneDatabaseIdentity,
} from "../../src/db/control-plane-database-identity";

const identity: ControlPlaneDatabaseIdentity = {
  systemIdentifier: "7627039817244368896",
  databaseOid: "16384",
  databaseName: "supacloud_meta",
  databaseOwner: "postgres",
};
const snapshotId = "00000003-0000001B-1";

function databaseReturning(row: Record<string, unknown>, snapshotAvailable = true): SQL {
  const transaction = Object.assign(async () => [row], {
    unsafe: async (statement: string) => {
      if (statement.startsWith("SET TRANSACTION SNAPSHOT") && !snapshotAvailable) {
        throw new Error("snapshot is not valid on this server");
      }
      return [];
    },
  });
  return Object.assign(async () => [row], {
    begin: async (operation: (connection: SQL) => Promise<unknown>) => operation(transaction as unknown as SQL),
  }) as unknown as SQL;
}

describe("control-plane physical database identity", () => {
  test("derives a stable fingerprint from cluster and database identity", () => {
    const fingerprint = controlPlaneDatabaseFingerprint(identity);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(controlPlaneDatabaseFingerprint({ ...identity })).toBe(fingerprint);
    expect(controlPlaneDatabaseFingerprint({ ...identity, databaseOid: "16385" })).not.toBe(fingerprint);
    expect(controlPlaneDatabaseFingerprint({ ...identity, systemIdentifier: "7627039817244368897" }))
      .not.toBe(fingerprint);
  });

  test("accepts identity A and rejects a migration connection to identity B", async () => {
    const identityA = databaseReturning({
      system_identifier: identity.systemIdentifier,
      database_oid: identity.databaseOid,
      database_name: identity.databaseName,
      database_owner: identity.databaseOwner,
    });
    expect(await inspectControlPlaneDatabaseIdentity(identityA)).toEqual(identity);
    await expect(assertExpectedControlPlaneDatabaseIdentity(
      identityA,
      controlPlaneDatabaseFingerprint(identity),
      snapshotId,
    )).resolves.toBeUndefined();
    const identityB = databaseReturning({
      system_identifier: "7627039817244368897",
      database_oid: identity.databaseOid,
      database_name: identity.databaseName,
      database_owner: identity.databaseOwner,
    });
    await expect(assertExpectedControlPlaneDatabaseIdentity(
      identityB,
      controlPlaneDatabaseFingerprint(identity),
      snapshotId,
    ))
      .rejects.toThrow("does not match the verified upgrade backup");
  });

  test("rejects a cloned node with the same static fingerprint but no live exporter snapshot", async () => {
    const clonedNode = databaseReturning({
      system_identifier: identity.systemIdentifier,
      database_oid: identity.databaseOid,
      database_name: identity.databaseName,
      database_owner: identity.databaseOwner,
    }, false);
    await expect(assertExpectedControlPlaneDatabaseIdentity(
      clonedNode,
      controlPlaneDatabaseFingerprint(identity),
      snapshotId,
    )).rejects.toThrow("could not verify the live backup snapshot");
  });

  test("keeps the live snapshot guard and migration writes in one transaction", async () => {
    const events: string[] = [];
    const transaction = Object.assign(async () => {
      events.push("identity");
      return [{
        system_identifier: identity.systemIdentifier,
        database_oid: identity.databaseOid,
        database_name: identity.databaseName,
        database_owner: identity.databaseOwner,
      }];
    }, {
      unsafe: async (statement: string) => {
        events.push(statement.startsWith("SET TRANSACTION SNAPSHOT") ? "snapshot" : "isolation");
        return [];
      },
    }) as unknown as SQL;
    const database = Object.assign(async () => [], {
      begin: async (operation: (connection: SQL) => Promise<unknown>) => {
        events.push("begin");
        const operationResult = await operation(transaction);
        events.push("commit");
        return operationResult;
      },
    }) as unknown as SQL;

    await withExpectedControlPlaneDatabaseTransaction(database, async (migration) => {
      expect(migration).toBe(transaction);
      events.push("write");
    }, controlPlaneDatabaseFingerprint(identity), snapshotId);

    expect(events).toEqual(["begin", "isolation", "snapshot", "identity", "write", "commit"]);
  });

  test("runs all init-db writes inside the guarded transaction", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/db/init.ts"), "utf8");
    const reserve = source.indexOf("const sqlConnection = await sqlPool.reserve()");
    const initializer = source.indexOf("async function initializeControlPlaneSchema(transaction: TransactionSQL)");
    const transaction = source.indexOf("sql = transaction", initializer);
    const firstWrite = source.indexOf("await sql.unsafe(ddlQuery)");
    const guard = source.indexOf(
      "await withExpectedControlPlaneDatabaseTransaction(sqlConnection, initializeControlPlaneSchema)",
    );
    expect(reserve).toBeGreaterThan(0);
    expect(initializer).toBeGreaterThan(reserve);
    expect(transaction).toBeGreaterThan(initializer);
    expect(firstWrite).toBeGreaterThan(transaction);
    expect(guard).toBeGreaterThan(firstWrite);
    expect(source).not.toContain("await sql.begin");
    expect(source).toContain("sqlConnection.release()");
  });

  test("keeps standalone init-db compatible when no expected fingerprint is supplied", async () => {
    let queried = false;
    const database = (async () => {
      queried = true;
      throw new Error("must not query without an upgrade guard");
    }) as unknown as SQL;
    await expect(assertExpectedControlPlaneDatabaseIdentity(database, undefined)).resolves.toBeUndefined();
    expect(queried).toBe(false);
  });

  test("rejects malformed expected fingerprints before reading the database", async () => {
    let queried = false;
    const database = (async () => {
      queried = true;
      return [];
    }) as unknown as SQL;
    for (const invalid of ["", "A".repeat(64), "0".repeat(63), "0".repeat(65)]) {
      expect(() => parseExpectedControlPlaneDatabaseFingerprint(invalid)).toThrow("lowercase SHA-256");
      await expect(assertExpectedControlPlaneDatabaseIdentity(database, invalid, snapshotId))
        .rejects.toThrow("identity guard is invalid");
    }
    expect(queried).toBe(false);
  });

  test("rejects incomplete and malformed snapshot guards before reading the database", async () => {
    let queried = false;
    const database = Object.assign(async () => {
      queried = true;
      return [];
    }, {
      begin: async () => {
        queried = true;
      },
    }) as unknown as SQL;
    const fingerprint = controlPlaneDatabaseFingerprint(identity);
    await expect(assertExpectedControlPlaneDatabaseIdentity(database, fingerprint, "invalid"))
      .rejects.toThrow("identity guard is invalid");
    expect(() => parseExpectedControlPlaneDatabaseSnapshot("invalid"))
      .toThrow("PostgreSQL snapshot identifier");
    await expect(assertExpectedControlPlaneDatabaseIdentity(database, fingerprint, undefined))
      .rejects.toThrow("identity guard is incomplete");
    expect(queried).toBe(false);
  });

  test("rejects incomplete physical database identity rows", async () => {
    await expect(inspectControlPlaneDatabaseIdentity(databaseReturning({
      system_identifier: identity.systemIdentifier,
      database_oid: "0",
      database_name: identity.databaseName,
      database_owner: identity.databaseOwner,
    }))).rejects.toThrow("identity is unavailable");
  });
});
