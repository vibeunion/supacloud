import type { SQL, TransactionSQL } from "bun";
import { createHash } from "node:crypto";

export const CONTROL_PLANE_DATABASE_FINGERPRINT_ENV =
  "SUPACLOUD_EXPECTED_CONTROL_PLANE_DATABASE_FINGERPRINT";
export const CONTROL_PLANE_DATABASE_SNAPSHOT_ENV =
  "SUPACLOUD_EXPECTED_CONTROL_PLANE_DATABASE_SNAPSHOT";
export const CONTROL_PLANE_DATABASE_GUARD_EXIT_CODE = 78;

const DATABASE_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const SYSTEM_IDENTIFIER_PATTERN = /^\d{1,20}$/;
const DATABASE_OID_PATTERN = /^[1-9]\d{0,9}$/;
const SNAPSHOT_ID_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{8}-\d+$/i;

export type ControlPlaneDatabaseIdentity = {
  systemIdentifier: string;
  databaseOid: string;
  databaseName: string;
  databaseOwner: string;
};

export class ControlPlaneDatabaseGuardError extends Error {
  override readonly name = "ControlPlaneDatabaseGuardError";
}

type ControlPlaneDatabaseGuard = {
  fingerprint: string;
  snapshot: string;
};

function postgresIdentifier(rawIdentifier: unknown, identifierField: string): string {
  if (typeof rawIdentifier !== "string"
    || rawIdentifier.length === 0
    || Buffer.byteLength(rawIdentifier, "utf8") > 63
    || /[\u0000-\u001f\u007f]/u.test(rawIdentifier)) {
    throw new Error(`Control-plane database ${identifierField} is invalid`);
  }
  return rawIdentifier;
}

export function controlPlaneDatabaseFingerprint(identity: ControlPlaneDatabaseIdentity): string {
  return createHash("sha256")
    .update("supacloud.control-plane-database-identity.v1\0")
    .update([
      identity.systemIdentifier,
      identity.databaseOid,
      identity.databaseName,
      identity.databaseOwner,
    ].join("\0"))
    .digest("hex");
}

export async function inspectControlPlaneDatabaseIdentity(
  database: SQL,
): Promise<ControlPlaneDatabaseIdentity> {
  const [row] = await database`
    SELECT (pg_control_system()).system_identifier::text AS system_identifier,
           database.oid::text AS database_oid,
           database.datname AS database_name,
           pg_get_userbyid(database.datdba) AS database_owner
    FROM pg_database AS database
    WHERE database.datname = current_database()
  `;
  if (!row
    || typeof row.system_identifier !== "string"
    || !SYSTEM_IDENTIFIER_PATTERN.test(row.system_identifier)
    || typeof row.database_oid !== "string"
    || !DATABASE_OID_PATTERN.test(row.database_oid)) {
    throw new Error("Control-plane physical database identity is unavailable");
  }
  return {
    systemIdentifier: row.system_identifier,
    databaseOid: row.database_oid,
    databaseName: postgresIdentifier(row.database_name, "name"),
    databaseOwner: postgresIdentifier(row.database_owner, "owner"),
  };
}

export function parseExpectedControlPlaneDatabaseFingerprint(rawFingerprint: string): string {
  if (!DATABASE_FINGERPRINT_PATTERN.test(rawFingerprint)) {
    throw new Error(`${CONTROL_PLANE_DATABASE_FINGERPRINT_ENV} must be a lowercase SHA-256 fingerprint`);
  }
  return rawFingerprint;
}

export function parseExpectedControlPlaneDatabaseSnapshot(rawSnapshot: string): string {
  if (!SNAPSHOT_ID_PATTERN.test(rawSnapshot)) {
    throw new Error(`${CONTROL_PLANE_DATABASE_SNAPSHOT_ENV} must be a PostgreSQL snapshot identifier`);
  }
  return rawSnapshot;
}

function expectedControlPlaneDatabaseGuard(
  expectedFingerprint: string | undefined,
  expectedSnapshot: string | undefined,
): ControlPlaneDatabaseGuard | null {
  if (expectedFingerprint === undefined && expectedSnapshot === undefined) return null;
  if (expectedFingerprint === undefined || expectedSnapshot === undefined) {
    throw new ControlPlaneDatabaseGuardError("Control-plane upgrade database identity guard is incomplete");
  }
  try {
    return {
      fingerprint: parseExpectedControlPlaneDatabaseFingerprint(expectedFingerprint),
      snapshot: parseExpectedControlPlaneDatabaseSnapshot(expectedSnapshot),
    };
  } catch (error: unknown) {
    throw new ControlPlaneDatabaseGuardError("Control-plane upgrade database identity guard is invalid", {
      cause: error,
    });
  }
}

async function assertLiveControlPlaneDatabaseGuard(
  database: SQL,
  guard: ControlPlaneDatabaseGuard,
): Promise<void> {
  try {
    await database.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await database.unsafe(`SET TRANSACTION SNAPSHOT '${guard.snapshot}'`);
    const actual = controlPlaneDatabaseFingerprint(await inspectControlPlaneDatabaseIdentity(database));
    if (actual !== guard.fingerprint) {
      throw new ControlPlaneDatabaseGuardError(
        "Control-plane database identity does not match the verified upgrade backup",
      );
    }
  } catch (error: unknown) {
    if (error instanceof ControlPlaneDatabaseGuardError) throw error;
    throw new ControlPlaneDatabaseGuardError(
      "Control-plane database identity guard could not verify the live backup snapshot",
      { cause: error },
    );
  }
}

export async function assertExpectedControlPlaneDatabaseIdentity(
  database: SQL,
  expectedFingerprint = process.env[CONTROL_PLANE_DATABASE_FINGERPRINT_ENV],
  expectedSnapshot = process.env[CONTROL_PLANE_DATABASE_SNAPSHOT_ENV],
): Promise<void> {
  const guard = expectedControlPlaneDatabaseGuard(expectedFingerprint, expectedSnapshot);
  if (guard) {
    await database.begin((transaction) => assertLiveControlPlaneDatabaseGuard(transaction, guard));
  }
}

export async function withExpectedControlPlaneDatabaseTransaction<T>(
  database: SQL,
  operation: (transaction: TransactionSQL) => Promise<T>,
  expectedFingerprint = process.env[CONTROL_PLANE_DATABASE_FINGERPRINT_ENV],
  expectedSnapshot = process.env[CONTROL_PLANE_DATABASE_SNAPSHOT_ENV],
): Promise<T> {
  const guard = expectedControlPlaneDatabaseGuard(expectedFingerprint, expectedSnapshot);
  return database.begin(async (transaction) => {
    if (guard) await assertLiveControlPlaneDatabaseGuard(transaction, guard);
    return operation(transaction);
  });
}
