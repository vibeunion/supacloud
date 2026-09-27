import { createHash } from "node:crypto";
import type { DeliveryMigrationArchive } from "./delivery-migration-archive";

export interface DeliveryMigrationInventoryEntry {
  version: string;
  name: string | null;
  checksum: string;
}

/** Compares identities, not SQL semantics; a ledger match never proves rollback compatibility. */
export function buildDeliveryMigrationPlan(
  archive: DeliveryMigrationArchive, inventory: readonly DeliveryMigrationInventoryEntry[], ref: string,
) {
  const project = archive.migrations.filter(entry => entry.executor === "project-migration");
  const latestVersion = inventory.reduce((latest, entry) =>
    BigInt(entry.version) > latest ? BigInt(entry.version) : latest, 0n);
  const migrations = project.map(entry => {
    const checksum = createHash("sha256").update(JSON.stringify({
      version: entry.version, name: entry.name, statements: [entry.sql.replace(/\r\n?/g, "\n").trim()],
    })).digest("hex");
    const sameVersion = inventory.find(remote => remote.version === entry.version);
    const sameName = inventory.filter(remote => remote.name === entry.name);
    let status: "ledger-match" | "pending" | "name-conflict" | "checksum-mismatch" | "out-of-order";
    if (project.filter(item => item.name === entry.name).length > 1
      || sameName.some(remote => remote.version !== entry.version)
      || (sameVersion && sameVersion.name !== entry.name)) status = "name-conflict";
    else if (sameVersion) status = sameVersion.checksum === checksum ? "ledger-match" : "checksum-mismatch";
    else status = BigInt(entry.version) <= latestVersion ? "out-of-order" : "pending";
    return { version: entry.version, name: entry.name, rawSha256: entry.sha256, ledgerChecksum: checksum, status };
  });
  const conflicts = migrations.filter(entry => entry.status !== "ledger-match" && entry.status !== "pending");
  return {
    version: 1 as const,
    operation: "database.delivery_migration_plan" as const,
    projectRef: ref,
    delivery: { target: archive.target, objectId: archive.objectId, artifactVerified: archive.artifactVerified },
    ledgerCompatible: conflicts.length === 0,
    migrations,
    operatorProvisioning: archive.migrations.filter(entry => entry.executor === "operator-provisioning")
      .map(entry => ({
        version: entry.version, name: entry.name, rawSha256: entry.sha256,
        status: "separate-verification-required" as const,
      })),
    compatibility: "not-proven" as const,
    executionPerformed: false as const,
    deploymentVerified: false as const,
    dataRecovery: "separate-required" as const,
  };
}
