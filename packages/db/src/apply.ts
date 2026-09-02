/**
 * Apply：把 ModulePlan 落到数据库 —— 账本幂等 + advisory lock + 单事务 + catalog 回读验证。
 * 边界与 plan 一致：只管模块声明的可重复 SQL 对象，不做表结构 migration。
 */

import { readCatalog, type DatabaseCatalog, type QueryExecutor } from './catalog.js';
import type { ModulePlan, PlanStep } from './plan.js';
import { splitQualifiedName } from './reconcile.js';

export interface ApplyResult {
  module: string;
  /** 实际执行了 SQL 的 step 名 */
  applied: string[];
  /** ledger 哈希一致跳过的 */
  skipped: string[];
  /** 应用后在 catalog 中确认存在的对象 */
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
// Transaction-scoped lock: must execute through the transaction-bound executor.
// A session lock acquired before transaction() can land on a different pool
// connection and fail to serialize the actual apply operation.
const LOCK_SQL = `select pg_advisory_xact_lock(hashtext('supacloud-db-apply'))`;
const LEDGER_READ_SQL =
  'select sha256 from _supacloud.db_object_ledger where object_identity = $1';
const LEDGER_UPSERT_SQL = `insert into _supacloud.db_object_ledger (object_identity, module, sha256)
values ($1, $2, $3)
on conflict (object_identity) do update
set module = excluded.module, sha256 = excluded.sha256, applied_at = now()`;

/** 携带失败 step 名的内部错误，事务回滚后据此填充 ApplyResult.failed */
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
 * 在事务中执行 fn。transaction callback 必须提供绑定到同一连接的 executor，
 * 否则 advisory lock 无法可靠覆盖实际写入。
 * 失败时回滚并返回失败信息（不抛出）。
 */
async function runInTransaction(
  executor: QueryExecutor,
  fn: (tx: QueryExecutor) => Promise<void>,
): Promise<{ step: string; error: string } | undefined> {
  if (!executor.transaction) {
    throw new Error(
      'applyModulePlan requires QueryExecutor.transaction with a connection-bound executor',
    );
  }
  try {
    await executor.transaction(fn);
    return undefined;
  } catch (error) {
    return toFailure(error);
  }
}

/** step 声明的对象在 catalog 中是否存在 */
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
        (t) => t.schema === schema && t.table === table && t.name === name && t.enabled,
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

/** 从 step 名推导 catalog 验证需要覆盖的 schema 集合 */
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
  // error 级风险直接拒绝执行，不触碰数据库
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

  // 事务内先写入局部数组，提交成功后才算真正 applied/skipped（回滚则丢弃）。
  // 锁也在同一事务内获取，确保连接池/托管 transaction 实现下锁覆盖实际执行。
  const applied: string[] = [];
  const skipped: string[] = [];
  const failed = await runInTransaction(executor, async (tx) => {
    await tx.query(LOCK_SQL);
    await tx.query(LEDGER_SCHEMA_SQL);
    await tx.query(LEDGER_TABLE_SQL);
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

  // 应用后读回 catalog，验证声明对象真实存在
  const catalog = await readCatalog(executor, planSchemas(plan));
  for (const step of plan.steps) {
    if (existsInCatalog(step, catalog)) {
      result.verified.push(step.name);
    } else {
      result.failed = {
        step: step.name,
        error: `应用后 catalog 中未找到或未启用 ${step.kind} ${step.name}`,
      };
      break;
    }
  }

  return result;
}
