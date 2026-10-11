import { buildDeliveryMigrationPlan, type DeliveryMigrationArchive } from "@supacloud/delivery";
import type { SQL } from "bun";
import { getProjectDb, resolveDbName } from "../db";
import { stableSha256, stableStringify } from "../utils/stable-json";
import { ApplicationReleaseStorage } from "./application-release-storage";
import { readMigrationInventory } from "./migration-ledger";
import { applyRecordedMigration, deriveMigrationExecution } from "./project-migration-executor";
import { projectRepository } from "../repositories/project.repository";
import { withProjectMigrationLocks } from "./migration-lock";
import {
  calculateMigrationChecksum,
  detectDestructiveMigrationOperations, detectNonTransactionalMigrationOperations,
  detectUnsupportedMigrationOperations,
} from "./migration-promotion";
import { createLogicalBackup, readLogicalBackup } from "./logical-backup.service";
import type { LogicalBackupIdentity } from "../types/backup";

type Inventory = Awaited<ReturnType<typeof readMigrationInventory>>;

export interface ApplicationMigrationDependencies {
  storage?: Pick<ApplicationReleaseStorage, "readMigrations">;
  inventory?: (projectRef: string) => Promise<Inventory>;
  execute?: (input: {
    projectRef: string;
    version: string;
    name: string;
    statements: readonly string[];
    conflictOnName: boolean;
  }) => ReturnType<typeof applyRecordedMigration>;
  withLock?: typeof withProjectMigrationLocks;
  backups?: {
    create: typeof createLogicalBackup;
    read: typeof readLogicalBackup;
  };
  now?: () => number;
}

export interface ApplyApplicationMigrationsInput {
  projectRef: string;
  applicationId: string;
  releaseId: string;
  expectedLedgerDigest: string;
  backupId?: string;
  approvedMigrationDigest?: string;
}

export class ApplicationMigrationError extends Error {
  constructor(readonly code: string, readonly statusCode: number) { super(code); }
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
  private readonly execute: NonNullable<ApplicationMigrationDependencies["execute"]>;
  private readonly withLock: typeof withProjectMigrationLocks;
  private readonly backups: NonNullable<ApplicationMigrationDependencies["backups"]>;
  private readonly now: () => number;

  constructor(dependencies: ApplicationMigrationDependencies = {}) {
    this.storage = dependencies.storage ?? new ApplicationReleaseStorage();
    this.inventory = dependencies.inventory ?? projectInventory;
    this.execute = dependencies.execute ?? (async input => {
      const project = await projectRepository.findByRef(input.projectRef);
      if (!project) throw new ApplicationMigrationError("APPLICATION_MIGRATION_PROJECT_NOT_FOUND", 404);
      return applyRecordedMigration({ ...input, credentials: {
        db_name: project.db_name, db_user: project.db_user, db_password: project.db_password,
      } });
    });
    this.withLock = dependencies.withLock ?? withProjectMigrationLocks;
    this.backups = dependencies.backups ?? { create: createLogicalBackup, read: readLogicalBackup };
    this.now = dependencies.now ?? Date.now;
  }

  async inspect(projectRef: string, applicationId: string, releaseId: string) {
    const { record, archives } = await this.storage.readMigrations(projectRef, applicationId, releaseId);
    return this.inspectArchives(projectRef, applicationId, record, archives);
  }

  async inspectArchives(
    projectRef: string,
    applicationId: string,
    record: Awaited<ReturnType<ApplicationReleaseStorage["readMigrations"]>>["record"],
    archives: DeliveryMigrationArchive[],
  ) {
    const inventory = await this.inventory(projectRef);
    return this.compareInventory(projectRef, applicationId, record, archives, inventory);
  }

  private compareInventory(
    projectRef: string,
    applicationId: string,
    record: Awaited<ReturnType<ApplicationReleaseStorage["readMigrations"]>>["record"],
    archives: DeliveryMigrationArchive[],
    inventory: Inventory,
  ) {
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

  private async executionPlan(scope: { projectRef: string; applicationId: string; releaseId: string }) {
    if (!/^[a-z0-9-]{1,20}$/.test(scope.projectRef)
      || !/^[A-Za-z0-9_-]{1,64}$/.test(scope.applicationId) || !/^[a-f0-9]{64}$/.test(scope.releaseId)) {
      throw new ApplicationMigrationError("APPLICATION_MIGRATION_IDENTITY_INVALID", 400);
    }
    const { record, archives } = await this.storage.readMigrations(
      scope.projectRef, scope.applicationId, scope.releaseId,
    );
    if (record.project_ref !== scope.projectRef || record.application_id !== scope.applicationId
      || record.release_id !== scope.releaseId) {
      throw new ApplicationMigrationError("APPLICATION_MIGRATION_RELEASE_MISMATCH", 409);
    }
    const inventory = await this.inventory(scope.projectRef);
    const report = this.compareInventory(scope.projectRef, scope.applicationId, record, archives, inventory);
    const pendingVersions = new Set(report.targets.flatMap(target => target.migrations
      .filter(entry => entry.status === "pending").map(entry => entry.version)));
    const pending = new Map<string, DeliveryMigrationArchive["migrations"][number]>();
    for (const archive of archives) {
      for (const entry of archive.migrations) {
        if (entry.executor === "project-migration" && pendingVersions.has(entry.version)) pending.set(entry.version, entry);
      }
    }
    const ordered = [...pending.values()].sort((a, b) =>
      BigInt(a.version) < BigInt(b.version) ? -1 : BigInt(a.version) > BigInt(b.version) ? 1 : 0);
    const migrations = ordered.map(entry => {
      const statements = deriveMigrationExecution([entry.sql]).statements;
      return {
        version: entry.version, name: entry.name, raw_sha256: entry.sha256,
        destructive: detectDestructiveMigrationOperations(statements),
        unsupported: detectUnsupportedMigrationOperations(statements),
        non_transactional: detectNonTransactionalMigrationOperations(statements),
      };
    });
    const value = {
      schema: "supacloud.application-migration-execution-plan.v1" as const,
      project_ref: scope.projectRef, application_id: scope.applicationId, release_id: scope.releaseId,
      manifest_sha256: record.manifest_sha256, ledger_digest: report.ledger_digest, migrations,
      ledger_compatible: report.ledger_compatible,
      operator_provisioning_required: report.operator_provisioning !== "not-declared",
      backup_required: ordered.length > 0,
      destructive_confirmation_required: migrations.some(entry => entry.destructive.length > 0),
      execution_performed: false as const,
    };
    const projected = new Map(inventory.map(({ version, name, checksum }) => [version, { version, name, checksum }]));
    for (const entry of ordered) projected.set(entry.version, {
      version: entry.version, name: entry.name,
      checksum: calculateMigrationChecksum({ version: entry.version, name: entry.name, statements: [entry.sql] }),
    });
    const expectedAfterDigest = stableSha256([...projected.values()]
      .sort((a, b) => BigInt(a.version) < BigInt(b.version) ? -1 : BigInt(a.version) > BigInt(b.version) ? 1 : 0));
    return { plan: { ...value, plan_sha256: stableSha256(value) }, report, ordered, expectedAfterDigest };
  }

  async readExecutionPlan(scope: { projectRef: string; applicationId: string; releaseId: string }) {
    return structuredClone((await this.executionPlan(scope)).plan);
  }

  /** 调用方必须先写持久 checkpoint；本模块不重试未知结果，也不进行数据库恢复。 */
  async apply(request: ApplyApplicationMigrationsInput) {
    const input = structuredClone(request);
    if (!/^[a-z0-9-]{1,20}$/.test(input.projectRef) || !/^[a-f0-9]{64}$/.test(input.expectedLedgerDigest)) {
      throw new ApplicationMigrationError("APPLICATION_MIGRATION_IDENTITY_INVALID", 400);
    }
    return this.withLock({ projectRefs: [input.projectRef] }, async () => {
      const { plan, report: before, ordered, expectedAfterDigest } = await this.executionPlan(input);
      if (plan.ledger_digest !== input.expectedLedgerDigest) {
        throw new ApplicationMigrationError("APPLICATION_MIGRATION_PLAN_CHANGED", 409);
      }
      if (!plan.ledger_compatible) throw new ApplicationMigrationError("APPLICATION_MIGRATION_CONFLICT", 409);
      if (plan.operator_provisioning_required) {
        throw new ApplicationMigrationError("APPLICATION_OPERATOR_PROVISIONING_REQUIRED", 409);
      }
      if (plan.migrations.some(entry => entry.unsupported.length || entry.non_transactional.length)) {
        throw new ApplicationMigrationError("APPLICATION_MIGRATION_SQL_UNSUPPORTED", 409);
      }
      if (plan.destructive_confirmation_required && input.approvedMigrationDigest !== plan.plan_sha256) {
        throw new ApplicationMigrationError("APPLICATION_MIGRATION_REVIEW_REQUIRED", 409);
      }
      let backup: LogicalBackupIdentity | null = null;
      if (ordered.length) {
        const prefix = `logical-full_${input.projectRef}_`;
        if (!input.backupId || !input.backupId.startsWith(prefix)
          || !/^[a-f0-9]{32}$/.test(input.backupId.slice(prefix.length))) {
          throw new ApplicationMigrationError("APPLICATION_MIGRATION_BACKUP_ID_REQUIRED", 400);
        }
        let created: LogicalBackupIdentity, observed: LogicalBackupIdentity;
        try {
          created = await this.backups.create(input.projectRef, input.backupId);
          observed = await this.backups.read(input.projectRef, input.backupId);
        } catch {
          throw new ApplicationMigrationError("APPLICATION_MIGRATION_BACKUP_UNVERIFIED", 503);
        }
        const age = this.now() - Date.parse(created.completed_at);
        if (created.backup_id !== input.backupId || created.project_ref !== input.projectRef
          || created.kind !== "logical-full" || !/^[a-f0-9]{64}$/.test(created.sha256)
          || !Number.isSafeInteger(created.bytes) || created.bytes <= 0
          || !Number.isFinite(age) || age < 0 || age > 30 * 60 * 1000
          || stableStringify(created) !== stableStringify(observed)) {
          throw new ApplicationMigrationError("APPLICATION_MIGRATION_BACKUP_UNVERIFIED", 503);
        }
        backup = observed;
        const current = await this.executionPlan(input);
        if (current.plan.plan_sha256 !== plan.plan_sha256) {
          throw new ApplicationMigrationError("APPLICATION_MIGRATION_PLAN_CHANGED", 409);
        }
      }
      const applied: Array<Awaited<ReturnType<typeof applyRecordedMigration>> & { version: string; name: string }> = [];
      for (const entry of ordered) {
        let receipt: Awaited<ReturnType<typeof applyRecordedMigration>>;
        try {
          receipt = await this.execute({
            projectRef: input.projectRef, version: entry.version, name: entry.name,
            statements: [entry.sql], conflictOnName: true,
          });
        } catch {
          throw new ApplicationMigrationError("APPLICATION_MIGRATION_OUTCOME_UNKNOWN", 503);
        }
        const expected = before.targets.flatMap(target => target.migrations).find(candidate => candidate.version === entry.version);
        if (!expected || receipt.checksum !== expected.ledgerChecksum) {
          throw new ApplicationMigrationError("APPLICATION_MIGRATION_RECEIPT_MISMATCH", 503);
        }
        applied.push({ ...receipt, version: entry.version, name: entry.name });
      }
      const after = await this.inspect(input.projectRef, input.applicationId, input.releaseId);
      if (!after.ledger_compatible || !after.project_migrations_applied || after.manifest_sha256 !== plan.manifest_sha256
        || after.ledger_digest !== expectedAfterDigest) {
        throw new ApplicationMigrationError("APPLICATION_MIGRATION_READBACK_FAILED", 503);
      }
      return { before, after, applied, backup };
    });
  }
}
