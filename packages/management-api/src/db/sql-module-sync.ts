import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SQL_MODULES } from "./sql-modules";
import type { SqlModuleId } from "./sql-modules";

type MarkerEdge = "start" | "end";

interface SqlModuleTarget {
  relativePath: string;
  moduleIds: readonly SqlModuleId[];
}

interface SqlModuleSyncOptions {
  repositoryRoot: string;
  check: boolean;
}

interface SqlModuleSyncReport {
  changedFiles: string[];
}

export const SQL_MODULE_TARGETS = [
  {
    relativePath: "packages/management-api/src/db/schemas/supabase.sql",
    moduleIds: [
      "auth-jwt-helpers",
      "storage-path-helpers",
      "postgrest-request-context",
      "pgmq-public",
    ],
  },
  {
    relativePath: "scripts/004_background_task_mirror_migration.sql",
    moduleIds: ["background-task-mirror-up", "background-task-mirror-down"],
  },
  {
    relativePath: "scripts/upgrade_pigsty_4_4_compat.sh",
    moduleIds: [
      "postgrest-request-context",
      "auth-jwt-helpers",
      "background-task-mirror-up",
    ],
  },
] as const satisfies readonly SqlModuleTarget[];

export function sqlModuleMarker(moduleId: string, edge: MarkerEdge): string {
  return `-- supacloud:sql-module:${moduleId}:${edge}`;
}

function countMarker(source: string, marker: string): number {
  return source.split(marker).length - 1;
}

function renderedModuleBlock(moduleId: string, sql: string): string {
  return `${sqlModuleMarker(moduleId, "start")}\n${sql.trim()}\n${sqlModuleMarker(moduleId, "end")}`;
}

export function replaceSqlModuleBlock(source: string, moduleId: string, sql: string): string {
  const startMarker = sqlModuleMarker(moduleId, "start");
  const endMarker = sqlModuleMarker(moduleId, "end");
  if (countMarker(source, startMarker) !== 1 || countMarker(source, endMarker) !== 1) {
    throw new Error(`SQL module ${moduleId} requires exactly one start and end marker`);
  }

  const blockStart = source.indexOf(startMarker);
  const blockEnd = source.indexOf(endMarker);
  if (blockEnd < blockStart) {
    throw new Error(`SQL module ${moduleId} markers must be ordered start before end`);
  }

  const suffixStart = blockEnd + endMarker.length;
  return source.slice(0, blockStart) + renderedModuleBlock(moduleId, sql) + source.slice(suffixStart);
}

function synchronizedTarget(source: string, moduleIds: readonly SqlModuleId[]): string {
  return moduleIds.reduce(
    (currentSource, moduleId) => replaceSqlModuleBlock(currentSource, moduleId, SQL_MODULES[moduleId]),
    source,
  );
}

interface SqlModuleTargetPlan {
  target: SqlModuleTarget;
  targetPath: string;
  currentSource: string;
  expectedSource: string;
}

async function planTargetSynchronization(
  repositoryRoot: string,
  target: SqlModuleTarget,
): Promise<SqlModuleTargetPlan> {
  const targetPath = resolve(repositoryRoot, target.relativePath);
  const currentSource = await readFile(targetPath, "utf8");
  const expectedSource = synchronizedTarget(currentSource, target.moduleIds);
  return { target, targetPath, currentSource, expectedSource };
}

export async function syncSqlModules(options: SqlModuleSyncOptions): Promise<SqlModuleSyncReport> {
  const plans = await Promise.all(
    SQL_MODULE_TARGETS.map((target) => planTargetSynchronization(options.repositoryRoot, target)),
  );
  const changedPlans = plans.filter((plan) => plan.expectedSource !== plan.currentSource);
  const changedFiles = changedPlans.map((plan) => plan.target.relativePath);
  if (options.check && changedFiles.length > 0) {
    throw new Error(`SQL module drift: ${changedFiles.join(", ")}`);
  }
  await Promise.all(
    changedPlans.map((plan) => writeFile(plan.targetPath, plan.expectedSource, "utf8")),
  );
  return { changedFiles };
}
