import { buildDeliveryMigrationPlan, type DeliveryMigrationArchive } from "@supacloud/delivery";
import type { SQL } from "bun";
import { getProjectDb, resolveDbName } from "../db";
import { stableSha256 } from "../utils/stable-json";
import { ApplicationReleaseStorage } from "./application-release-storage";
import { readMigrationInventory } from "./migration-ledger";

type Inventory = Awaited<ReturnType<typeof readMigrationInventory>>;

export interface ApplicationMigrationDependencies {
  storage?: Pick<ApplicationReleaseStorage, "readMigrations">;
  inventory?: (projectRef: string) => Promise<Inventory>;
}

async function projectInventory(projectRef: string): Promise<Inventory> {
  return readApplicationMigrationInventory(getProjectDb(await resolveDbName(projectRef)));
}

export async function readApplicationMigrationInventory(database: SQL): Promise<Inventory> {
  return database.begin(async transaction => {
    await transaction.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    // Older/missing ledgers are probed by catching SQL errors. A savepoint keeps
    // those expected errors from aborting the enclosing consistent snapshot.
    return readMigrationInventory({
      unsafe: query => transaction.savepoint(savepoint => savepoint.unsafe(query)),
    });
  });
}

export class ApplicationMigrations {
  private readonly storage: Pick<ApplicationReleaseStorage, "readMigrations">;
  private readonly inventory: (projectRef: string) => Promise<Inventory>;

  constructor(dependencies: ApplicationMigrationDependencies = {}) {
    this.storage = dependencies.storage ?? new ApplicationReleaseStorage();
    this.inventory = dependencies.inventory ?? projectInventory;
  }

  async inspect(projectRef: string, applicationId: string, releaseId: string) {
    const { record, archives } = await this.storage.readMigrations(projectRef, applicationId, releaseId);
    const inventory = await this.inventory(projectRef);
    const byVersion = new Map<string, DeliveryMigrationArchive["migrations"]>();
    for (const archive of archives) {
      for (const entry of archive.migrations) {
        const declarations = byVersion.get(entry.version) ?? [];
        declarations.push(entry);
        byVersion.set(entry.version, declarations);
      }
    }
    const conflicts = new Set([...byVersion].filter(([, entries]) =>
      entries.some(entry => entry.name !== entries[0]!.name || entry.sha256 !== entries[0]!.sha256
        || entry.executor !== entries[0]!.executor)).map(([version]) => version));
    const versionsByName = new Map<string, Set<string>>();
    for (const [version, declarations] of byVersion) {
      for (const entry of declarations) {
        const versions = versionsByName.get(entry.name) ?? new Set<string>();
        versions.add(version);
        versionsByName.set(entry.name, versions);
      }
    }
    for (const versions of versionsByName.values()) {
      if (versions.size > 1) for (const version of versions) conflicts.add(version);
    }
    const declarationConflicts = [...conflicts]
      .sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
    const plans = archives.map(archive => buildDeliveryMigrationPlan(archive, inventory, projectRef));
    const ledgerCompatible = declarationConflicts.length === 0 && plans.every(plan => plan.ledgerCompatible);
    const projectMigrationsApplied = ledgerCompatible
      && plans.every(plan => plan.migrations.every(entry => entry.status === "ledger-match"));
    return {
      schema: "supacloud.application-migrations.v1" as const,
      project_ref: projectRef, application_id: applicationId, release_id: record.release_id,
      manifest_sha256: record.manifest_sha256,
      ledger_digest: stableSha256(inventory.map(({ version, name, checksum }) => ({ version, name, checksum }))
        .sort((a, b) => BigInt(a.version) < BigInt(b.version) ? -1 : BigInt(a.version) > BigInt(b.version) ? 1 : 0)),
      ledger_compatible: ledgerCompatible,
      project_migrations_applied: projectMigrationsApplied,
      declaration_conflicts: declarationConflicts,
      targets: plans,
      operator_provisioning: plans.some(plan => plan.operatorProvisioning.length)
        ? "separate-verification-required" as const : "not-declared" as const,
      compatibility: "not-proven" as const,
      execution_performed: false as const,
      data_recovery: "separate-required" as const,
    };
  }
}
