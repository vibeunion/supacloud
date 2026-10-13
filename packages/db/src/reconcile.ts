/**
 * Reconciliation: Compares declarative Manifest (DatabaseModule) with PostgreSQL live Catalog.
 */

import type { DatabaseCatalog } from './catalog.js';
import type { DatabaseModule } from './module.js';

export interface ReconcileIssue {
  severity: 'error' | 'warn';
  code: string;
  message: string;
  /** Target object name */
  object: string;
}

export interface ReconcileReport {
  module: string;
  issues: ReconcileIssue[];
  /** True if no error-level issues */
  ok: boolean;
}

/** 'public.cases' -> ['public', 'cases']; defaults to public when schema prefix is absent */
export function splitQualifiedName(name: string): [string, string] {
  const dot = name.indexOf('.');
  if (dot === -1) return ['public', name];
  return [name.slice(0, dot), name.slice(dot + 1)];
}

/**
 * Checks explicit path configuration, not schema ACL safety.
 * An empty path is allowed; mixed empty elements and dynamic schemas are rejected.
 */
function isFixedSearchPath(searchPath: string | null): boolean {
  if (searchPath === null) return false;
  if (searchPath.trim() === '' || searchPath.trim() === '""') return true;
  const parts = searchPath.split(',').map((part) => part.trim().replace(/^"|"$/g, ''));
  return parts.every((part) =>
    part !== '' &&
    part.toLowerCase() !== 'pg_temp' &&
    part.toLowerCase() !== '$user',
  );
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

  // missing-policy: Declared policy does not exist in catalog
  for (const policy of module.policies) {
    const [schema, table] = splitQualifiedName(policy.table);
    const found = catalog.policies.find(
      (cp) => cp.schema === schema && cp.table === table && cp.name === policy.name,
    );
    if (!found) {
      push(
        'error',
        'missing-policy',
        `${policy.table}.${policy.name}`,
        `声明的策略 ${policy.name} 在表 ${policy.table} 的 catalog 中不存在`,
      );
    } else {
      if (found.command !== policy.operation) {
        push(
          'error',
          'policy-command-mismatch',
          `${policy.table}.${policy.name}`,
          `策略 ${policy.name} 声明为 ${policy.operation}，catalog 实际为 ${found.command}`,
        );
      }
      if (!sameRoles(policy.roles, found.roles)) {
        push(
          'error',
          'policy-roles-mismatch',
          `${policy.table}.${policy.name}`,
          `策略 ${policy.name} 声明角色与 catalog 不一致`,
        );
      }
      if (policy.usingExpr !== undefined &&
        policy.usingExpr !== (found.usingExpr ?? null)) {
        push(
          'error',
          'policy-using-mismatch',
          `${policy.table}.${policy.name}`,
          `策略 ${policy.name} 的 USING 表达式与 catalog 不一致`,
        );
      }
      if (policy.checkExpr !== undefined &&
        policy.checkExpr !== (found.checkExpr ?? null)) {
        push(
          'error',
          'policy-check-mismatch',
          `${policy.table}.${policy.name}`,
          `策略 ${policy.name} 的 WITH CHECK 表达式与 catalog 不一致`,
        );
      }
    }
  }

  // undeclared-policy: Policy exists in catalog on owned table but is not declared in manifest (drift warning)
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
    const candidates = catalog.functions.filter((f) => f.schema === schema && f.name === name);
    if (candidates.length === 0) {
      push(
        'error',
        'missing-function',
        fn.name,
        `声明的函数 ${fn.name} 在 catalog 中不存在`,
      );
      continue;
    }
    const cf = fn.signature !== undefined
      ? candidates.find((candidate) => functionSignature(candidate) === fn.signature)
      : candidates.length === 1
        ? candidates[0]
        : undefined;
    if (!cf) {
      push(
        'error',
        fn.signature !== undefined ? 'missing-function' : 'ambiguous-function-overload',
        fn.name,
        fn.signature !== undefined
          ? `声明的函数签名 ${fn.signature} 在 catalog 中不存在或缺少签名元数据`
          : `函数 ${fn.name} 存在多个重载，声明必须包含完整 signature`,
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

  // missing-trigger: Declared trigger does not exist in catalog (matched by schema.table + name)
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
    } else if (found.enabled !== (trigger.enabled ?? true)) {
      push(
        'error',
        found.enabled ? 'trigger-enabled-mismatch' : 'disabled-trigger',
        `${trigger.table}.${trigger.name}`,
        `声明的触发器 ${trigger.name} 的启用状态与 catalog 不一致`,
      );
    }
  }

  // undeclared-trigger: Trigger exists in catalog on owned table but is not declared in manifest
  // (including disabled ones, which are also drift requiring declaration or cleanup)
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

  // rls-disabled: Row Level Security is not enabled on owned table
  for (const table of module.tables) {
    const [schema, name] = splitQualifiedName(table);
    const ct = catalog.tables.find((t) => t.schema === schema && t.name === name);
    if (!ct) {
      push(
        'error',
        'missing-table',
        table,
        `声明的表 ${table} 在 catalog 中不存在`,
      );
    } else if (!ct.rlsEnabled) {
      push(
        'error',
        'rls-disabled',
        table,
        `归属表 ${table} 未开启行级安全（relrowsecurity = false）`,
      );
    }
  }

  // wildcard-grant: Permissions granted to PUBLIC role exist on owned table
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

  // grant-drift: Declared grant does not exist in catalog
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

function sameRoles(expected: string[], actual: string[]): boolean {
  const normalize = (roles: string[]) => [...new Set(roles)].sort();
  return JSON.stringify(normalize(expected)) === JSON.stringify(normalize(actual));
}

function functionSignature(
  functionEntry: DatabaseCatalog['functions'][number],
): string | undefined {
  if (functionEntry.identityArguments === undefined) return undefined;
  return `${functionEntry.schema}.${functionEntry.name}(${functionEntry.identityArguments})`;
}
