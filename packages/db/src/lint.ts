/**
 * Lint：对 SQL 源文本做正则级静态分析，无需数据库连接。
 */

import type { DatabaseModule } from './module.js';

export interface LintIssue {
  severity: 'error' | 'warn';
  code: string;
  message: string;
  file: string;
  line?: number;
}

const SECURITY_DEFINER_RE = /\bsecurity\s+definer\b/i;
const SET_SEARCH_PATH_RE = /\bset\s+search_path\b/i;
const GRANT_TO_PUBLIC_RE = /\bgrant\b[^;]*\bto\s+public\b/i;
const DROP_WITHOUT_IF_EXISTS_RE = /\bdrop\s+(?:table|column)\s+(?!if\s+exists\b)/i;
const ENABLE_RLS_RE = /\benable\s+row\s+level\s+security\b/i;

function lineOf(sql: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (sql.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

export function lintSql(sql: string, file: string): LintIssue[] {
  const issues: LintIssue[] = [];

  const definer = SECURITY_DEFINER_RE.exec(sql);
  if (definer && !SET_SEARCH_PATH_RE.test(sql)) {
    issues.push({
      severity: 'error',
      code: 'definer-no-search-path',
      message: 'security definer 函数必须显式 set search_path，避免 search_path 劫持',
      file,
      line: lineOf(sql, definer.index),
    });
  }

  const grantPublic = GRANT_TO_PUBLIC_RE.exec(sql);
  if (grantPublic) {
    issues.push({
      severity: 'error',
      code: 'grant-to-public',
      message: '禁止将权限授予 PUBLIC 角色',
      file,
      line: lineOf(sql, grantPublic.index),
    });
  }

  const drop = DROP_WITHOUT_IF_EXISTS_RE.exec(sql);
  if (drop) {
    issues.push({
      severity: 'warn',
      code: 'drop-without-if-exists',
      message: 'drop table/column 建议使用 if exists，保证迁移可重入',
      file,
      line: lineOf(sql, drop.index),
    });
  }

  return issues;
}

export async function lintModule(
  module: DatabaseModule,
  readFile: (path: string) => Promise<string>,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  // 收集全部声明的源文件并读取
  const sources = new Set<string>();
  for (const decl of [
    ...module.policies,
    ...module.functions,
    ...module.triggers,
    ...module.grants,
  ]) {
    sources.add(decl.source);
  }
  const contents = new Map<string, string>();
  await Promise.all(
    [...sources].map(async (path) => {
      contents.set(path, await readFile(path));
    }),
  );

  // 逐文件做 SQL 静态分析
  for (const [file, sql] of contents) {
    issues.push(...lintSql(sql, file));
  }

  // missing-rls-enable：声明了策略但没有任何源文件开启 RLS
  if (module.policies.length > 0) {
    const anyEnable = module.policies.some((policy) =>
      ENABLE_RLS_RE.test(contents.get(policy.source) ?? ''),
    );
    if (!anyEnable) {
      issues.push({
        severity: 'warn',
        code: 'missing-rls-enable',
        message: `模块 ${module.name} 声明了 ${module.policies.length} 条策略，但所有策略源文件都没有 enable row level security`,
        file: module.policies[0].source,
      });
    }
  }

  // policy-without-test：声明的策略/函数缺少测试条目
  for (const policy of module.policies) {
    if (!policy.tests || policy.tests.length === 0) {
      issues.push({
        severity: 'warn',
        code: 'policy-without-test',
        message: `策略 ${policy.name} 未声明测试文件`,
        file: policy.source,
      });
    }
  }
  for (const fn of module.functions) {
    if (!fn.tests || fn.tests.length === 0) {
      issues.push({
        severity: 'warn',
        code: 'policy-without-test',
        message: `函数 ${fn.name} 未声明测试文件`,
        file: fn.source,
      });
    }
  }

  return issues;
}
