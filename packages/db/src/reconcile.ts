/**
 * 对账：声明式 Manifest（DatabaseModule）与 PostgreSQL 真实 Catalog 比对。
 */

import type { DatabaseCatalog } from './catalog.js';
import type { DatabaseModule } from './module.js';

export interface ReconcileIssue {
  severity: 'error' | 'warn';
  code: string;
  message: string;
  /** 涉及对象名 */
  object: string;
}

export interface ReconcileReport {
  module: string;
  issues: ReconcileIssue[];
  /** 无 error 级问题 */
  ok: boolean;
}

/** 'public.cases' → ['public', 'cases']；无 schema 前缀时默认 public */
export function splitQualifiedName(name: string): [string, string] {
  const dot = name.indexOf('.');
  if (dot === -1) return ['public', name];
  return [name.slice(0, dot), name.slice(dot + 1)];
}

/**
 * search_path 是否固定安全：
 * 必须显式设置（非 null），且不含空元素或 pg_temp 等非固定 schema。
 */
function isFixedSearchPath(searchPath: string | null): boolean {
  if (searchPath === null) return false;
  const parts = searchPath.split(',').map((part) => part.trim().replace(/^"|"$/g, ''));
  return parts.every((part) => part !== '' && part.toLowerCase() !== 'pg_temp');
}

export function reconcileModule(
  module: DatabaseModule,
  catalog: DatabaseCatalog,
): ReconcileReport {
  const issues: ReconcileIssue[] = [];
  const ownedTables = new Set(module.tables);

  const push = (
    severity: ReconcileIssue['severity'],
    code: string,
    object: string,
    message: string,
  ) => issues.push({ severity, code, object, message });

  // missing-policy：声明的策略在 catalog 中不存在
  for (const policy of module.policies) {
    const [schema, table] = splitQualifiedName(policy.table);
    const found = catalog.policies.some(
      (cp) => cp.schema === schema && cp.table === table && cp.name === policy.name,
    );
    if (!found) {
      push(
        'error',
        'missing-policy',
        `${policy.table}.${policy.name}`,
        `声明的策略 ${policy.name} 在表 ${policy.table} 的 catalog 中不存在`,
      );
    }
  }

  // undeclared-policy：归属表上 catalog 有但 manifest 未声明的策略（漂移提示）
  const declaredPolicyKeys = new Set(module.policies.map((p) => `${p.table}::${p.name}`));
  for (const cp of catalog.policies) {
    const qualified = `${cp.schema}.${cp.table}`;
    if (ownedTables.has(qualified) && !declaredPolicyKeys.has(`${qualified}::${cp.name}`)) {
      push(
        'warn',
        'undeclared-policy',
        `${qualified}.${cp.name}`,
        `归属表 ${qualified} 上存在未声明的策略 ${cp.name}，可能发生漂移`,
      );
    }
  }

  // missing-function / security-mismatch / definer-without-search-path
  for (const fn of module.functions) {
    const [schema, name] = splitQualifiedName(fn.name);
    const cf = catalog.functions.find((f) => f.schema === schema && f.name === name);
    if (!cf) {
      push(
        'error',
        'missing-function',
        fn.name,
        `声明的函数 ${fn.name} 在 catalog 中不存在`,
      );
      continue;
    }
    if (cf.security !== fn.security) {
      push(
        'warn',
        'security-mismatch',
        fn.name,
        `函数 ${fn.name} 声明为 security ${fn.security}，catalog 实际为 ${cf.security}`,
      );
    }
    const effectiveDefiner = fn.security === 'definer' || cf.security === 'definer';
    if (effectiveDefiner && !isFixedSearchPath(cf.searchPath)) {
      push(
        'error',
        'definer-without-search-path',
        fn.name,
        `security definer 函数 ${fn.name} 未设置固定 search_path（当前: ${cf.searchPath ?? '未设置'}）`,
      );
    }
  }

  // missing-trigger：声明的触发器在 catalog 中不存在（按 schema.table + name 匹配）
  for (const trigger of module.triggers) {
    const [schema, table] = splitQualifiedName(trigger.table);
    const found = catalog.triggers.find(
      (ct) => ct.schema === schema && ct.table === table && ct.name === trigger.name,
    );
    if (!found) {
      push(
        'error',
        'missing-trigger',
        `${trigger.table}.${trigger.name}`,
        `声明的触发器 ${trigger.name} 在表 ${trigger.table} 的 catalog 中不存在`,
      );
    } else if (!found.enabled) {
      push(
        'error',
        'disabled-trigger',
        `${trigger.table}.${trigger.name}`,
        `声明的触发器 ${trigger.name} 在表 ${trigger.table} 上已禁用`,
      );
    }
  }

  // undeclared-trigger：归属表上 catalog 有但 manifest 未声明的触发器（含已禁用的，
  // 禁用的触发器同样属于漂移，需要显式声明或清理）
  const declaredTriggerKeys = new Set(module.triggers.map((t) => `${t.table}::${t.name}`));
  for (const ct of catalog.triggers) {
    const qualified = `${ct.schema}.${ct.table}`;
    if (ownedTables.has(qualified) && !declaredTriggerKeys.has(`${qualified}::${ct.name}`)) {
      push(
        'warn',
        'undeclared-trigger',
        `${qualified}.${ct.name}`,
        `归属表 ${qualified} 上存在未声明的触发器 ${ct.name}${ct.enabled ? '' : '（已禁用）'}，可能发生漂移`,
      );
    }
  }

  // rls-disabled：归属表未开启行级安全
  for (const table of module.tables) {
    const [schema, name] = splitQualifiedName(table);
    const ct = catalog.tables.find((t) => t.schema === schema && t.name === name);
    if (ct && !ct.rlsEnabled) {
      push(
        'error',
        'rls-disabled',
        table,
        `归属表 ${table} 未开启行级安全（relrowsecurity = false）`,
      );
    }
  }

  // wildcard-grant：归属表上存在授予 PUBLIC 的权限
  for (const grant of catalog.grants) {
    const qualified = `${grant.objectSchema}.${grant.objectName}`;
    if (ownedTables.has(qualified) && grant.grantee.toUpperCase() === 'PUBLIC') {
      push(
        'error',
        'wildcard-grant',
        qualified,
        `归属表 ${qualified} 存在授予 PUBLIC 的 ${grant.privilege} 权限`,
      );
    }
  }

  // grant-drift：声明的授权在 catalog 中不存在
  for (const grant of module.grants) {
    const [schema, name] = splitQualifiedName(grant.object);
    const found = catalog.grants.some(
      (cg) =>
        cg.objectSchema === schema &&
        cg.objectName === name &&
        cg.privilege.toLowerCase() === grant.privilege.toLowerCase() &&
        cg.grantee.toLowerCase() === grant.role.toLowerCase(),
    );
    if (!found) {
      push(
        'warn',
        'grant-drift',
        grant.object,
        `声明的授权 ${grant.privilege} ON ${grant.object} TO ${grant.role} 在 catalog 中不存在`,
      );
    }
  }

  return {
    module: module.name,
    issues,
    ok: !issues.some((issue) => issue.severity === 'error'),
  };
}
