/**
 * Apply: Executes ModulePlan against database - ledger idempotency + advisory lock + single transaction + catalog verification.
 * Boundary matches plan: handles repeatable SQL objects declared by modules, not table migrations.
 */

import { readCatalog, type DatabaseCatalog, type QueryExecutor } from './catalog.js';
import type { ModulePlan, PlanStep } from './plan.js';
import { splitQualifiedName } from './reconcile.js';

export interface ApplyResult {
  module: string;
  /** Names of steps whose SQL was executed */
  applied: string[];
  /** Steps skipped because ledger hash matched */
  skipped: string[];
  /** Objects confirmed to exist in catalog after apply */
  verified: string[];
  failed?: { step: string; error: string };
}

const LEDGER_SCHEMA_SQL = 'create schema if not exists _supacloud';
const LEDGER_TABLE_SQL = `create table if not exists _supacloud.db_object_ledger(
  object_identity text primary key,
  module text not null,
  sha256 text not null,
  applied_at timestamptz not null default now()
)`;
const LOCK_SQL = `select pg_advisory_lock(hashtext('supacloud-db-apply'))`;
const UNLOCK_SQL = `select pg_advisory_unlock(hashtext('supacloud-db-apply'))`;
const LEDGER_READ_SQL =
  'select sha256 from _supacloud.db_object_ledger where object_identity = $1';
const LEDGER_UPSERT_SQL = `insert into _supacloud.db_object_ledger (object_identity, module, sha256)
values ($1, $2, $3)
on conflict (object_identity) do update
set module = excluded.module, sha256 = excluded.sha256, applied_at = now()`;

/** Internal error carrying failed step name; used to populate ApplyResult.failed after transaction rollback */
class StepFailure extends Error {
  constructor(
    readonly step: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

function toFailure(error: unknown): { step: string; error: string } {
  if (error instanceof StepFailure) return { step: error.step, error: error.message };
  return { step: '(unknown)', error: error instanceof Error ? error.message : String(error) };
}

/**
 * Executes fn in transaction: delegates begin/commit/rollback to executor when it provides transaction,
 * otherwise sequentially executes begin/commit/rollback statements on current executor.
 * Rolls back on failure and returns failure info (does not throw).
 */
async function runInTransaction(
  executor: QueryExecutor,
  fn: (tx: QueryExecutor) => Promise<void>,
): Promise<{ step: string; error: string } | undefined> {
  if (executor.transaction) {
    try {
      await executor.transaction(fn);
      return undefined;
    } catch (error) {
      return toFailure(error);
    }
  }
  await executor.query('begin');
  try {
    await fn(executor);
  } catch (error) {
    await executor.query('rollback');
    return toFailure(error);
  }
  await executor.query('commit');
  return undefined;
}

/** Checks whether object declared by step exists in catalog */
function existsInCatalog(step: PlanStep, catalog: DatabaseCatalog): boolean {
  switch (step.kind) {
    case 'function': {
      const [schema, name] = splitQualifiedName(step.name);
      return catalog.functions.some((f) => f.schema === schema && f.name === name);
    }
    case 'policy': {
      const [schema, table, ...rest] = step.name.split('.');
      const name = rest.join('.');
      return catalog.policies.some(
        (p) => p.schema === schema && p.table === table && p.name === name,
      );
    }
    case 'trigger': {
      const [schema, table, ...rest] = step.name.split('.');
      const name = rest.join('.');
      return catalog.triggers.some(
        (t) => t.schema === schema && t.table === table && t.name === name,
      );
    }
    case 'grant': {
      const [object, privilege, role] = step.name.split(':');
      const [schema, name] = splitQualifiedName(object);
      return catalog.grants.some(
        (g) =>
          g.objectSchema === schema &&
          g.objectName === name &&
          g.privilege.toLowerCase() === privilege.toLowerCase() &&
          g.grantee.toLowerCase() === role.toLowerCase(),
      );
    }
  }
}

/** Derives set of schemas requiring catalog verification from step names */
function planSchemas(plan: ModulePlan): string[] {
  const schemas = new Set<string>();
  for (const step of plan.steps) {
    const target = step.kind === 'grant' ? step.name.split(':')[0] : step.name;
    schemas.add(splitQualifiedName(target)[0]);
  }
  return schemas.size > 0 ? [...schemas].sort() : ['public'];
}

export async function applyModulePlan(
  executor: QueryExecutor,
  plan: ModulePlan,
): Promise<ApplyResult> {
  // Reject execution directly on error-level risks without touching database
  const errorRisks = plan.steps.flatMap((step) =>
    step.risk
      .filter((risk) => risk.severity === 'error')
      .map((risk) => `${step.name}: ${risk.code} ${risk.message}`),
  );
  if (errorRisks.length > 0) {
    throw new Error(`plan 含 error 级风险，拒绝执行: ${errorRisks.join('; ')}`);
  }

  const result: ApplyResult = {
    module: plan.module,
    applied: [],
    skipped: [],
    verified: [],
  };

  // Ensure ledger table exists
  await executor.query(LEDGER_SCHEMA_SQL);
  await executor.query(LEDGER_TABLE_SQL);

  await executor.query(LOCK_SQL);
  try {
    // Collect applied/skipped in local arrays; only considered final after commit succeeds
    const applied: string[] = [];
    const skipped: string[] = [];
    const failed = await runInTransaction(executor, async (tx) => {
      for (const step of plan.steps) {
        const identity = `${step.kind}:${step.name}`;
        const rows = await tx.query<{ sha256: string }>(LEDGER_READ_SQL, [identity]);
        if (rows[0]?.sha256 === step.sha256) {
          skipped.push(step.name);
          continue;
        }
        try {
          await tx.query(step.sql);
          await tx.query(LEDGER_UPSERT_SQL, [identity, plan.module, step.sha256]);
        } catch (error) {
          throw new StepFailure(step.name, error);
        }
        applied.push(step.name);
      }
    });
    if (failed) {
      result.failed = failed;
      return result;
    }
    result.applied = applied;
    result.skipped = skipped;
  } finally {
    await executor.query(UNLOCK_SQL);
  }

  // Read back catalog after apply to verify declared objects actually exist
  const catalog = await readCatalog(executor, planSchemas(plan));
  for (const step of plan.steps) {
    if (existsInCatalog(step, catalog)) {
      result.verified.push(step.name);
    } else {
      result.failed = {
        step: step.name,
        error: `应用后 catalog 中未找到 ${step.kind} ${step.name}`,
      };
      break;
    }
  }

  return result;
}
