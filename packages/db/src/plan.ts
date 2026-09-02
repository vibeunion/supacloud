/**
 * Plan：把模块声明的可重复 SQL 对象（函数/策略/触发器/授权）编译为有序执行计划。
 * 边界：只管可重复对象，不做表结构 migration —— 表结构仍走前向 migration。
 */

import { lintSql } from './lint.js';
import type { DatabaseModule } from './module.js';

export interface PlanStep {
  kind: 'function' | 'policy' | 'trigger' | 'grant';
  /** 对象标识：函数为 schema 限定名；策略/触发器为 table.name；授权为 object:privilege:role */
  name: string;
  /** 模块相对路径 */
  source: string;
  /** 源文件内容哈希 */
  sha256: string;
  sql: string;
  risk: Array<{ severity: 'error' | 'warn'; code: string; message: string }>;
}

export interface ModulePlan {
  version: 1;
  module: string;
  createdAt: string;
  /** 依赖序：function -> policy -> trigger -> grant */
  steps: PlanStep[];
  /** 全部 step sha256 的组合哈希 */
  digest: string;
}

/** WebCrypto SHA-256（Node/Bun 均可用的全局 crypto），输出小写 hex */
async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function planModule(
  module: DatabaseModule,
  readFile: (path: string) => Promise<string>,
): Promise<ModulePlan> {
  // 同一源文件可能被多个声明引用，按路径缓存避免重复读取
  const contents = new Map<string, string>();
  const load = async (path: string): Promise<string> => {
    const cached = contents.get(path);
    if (cached !== undefined) return cached;
    const sql = await readFile(path);
    contents.set(path, sql);
    return sql;
  };

  const steps: PlanStep[] = [];
  const addStep = async (
    kind: PlanStep['kind'],
    name: string,
    source: string,
  ): Promise<void> => {
    const sql = await load(source);
    steps.push({
      kind,
      name,
      source,
      sha256: await sha256Hex(sql),
      sql,
      // 复用 lintSql 的静态分析结果作为 step 风险（error 级 lint 原样保留 severity=error）
      risk: lintSql(sql, source).map(({ severity, code, message }) => ({
        severity,
        code,
        message,
      })),
    });
  };

  for (const fn of module.functions) {
    await addStep('function', fn.name, fn.source);
  }
  for (const policy of module.policies) {
    await addStep('policy', `${policy.table}.${policy.name}`, policy.source);
  }
  for (const trigger of module.triggers) {
    await addStep('trigger', `${trigger.table}.${trigger.name}`, trigger.source);
  }
  for (const grant of module.grants) {
    await addStep('grant', `${grant.object}:${grant.privilege}:${grant.role}`, grant.source);
  }

  return {
    version: 1,
    module: module.name,
    createdAt: new Date().toISOString(),
    steps,
    digest: await sha256Hex(steps.map((step) => step.sha256).join('\n')),
  };
}
