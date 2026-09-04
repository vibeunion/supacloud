/**
 * Manifest: Aggregates multiple DatabaseModules into a serializable database governance inventory,
 * and provides explainObject for human-readable object explanation.
 */

import type {
  DatabaseModule,
  FunctionDecl,
  GrantDecl,
  PolicyDecl,
  TriggerDecl,
} from './module.js';

export interface DatabaseManifestModule {
  name: string;
  tables: string[];
  policies: PolicyDecl[];
  functions: FunctionDecl[];
  triggers: TriggerDecl[];
  grants: GrantDecl[];
}

export interface DatabaseManifest {
  version: 1;
  modules: DatabaseManifestModule[];
}

export function buildDatabaseManifest(modules: DatabaseModule[]): DatabaseManifest {
  return {
    version: 1,
    modules: modules.map((module) => ({
      name: module.name,
      tables: module.tables,
      policies: module.policies,
      functions: module.functions,
      triggers: module.triggers,
      grants: module.grants,
    })),
  };
}

function describePolicy(moduleName: string, policy: PolicyDecl): string {
  const lines = [
    `对象: ${policy.table}.${policy.name}`,
    '类型: 策略 (policy)',
    `所属模块: ${moduleName}`,
    `表: ${policy.table}`,
    `操作: ${policy.operation}`,
    `角色: ${policy.roles.join(', ')}`,
    `源文件: ${policy.source}`,
  ];
  if (policy.tests && policy.tests.length > 0) lines.push(`测试: ${policy.tests.join(', ')}`);
  return lines.join('\n');
}

function describeFunction(moduleName: string, fn: FunctionDecl): string {
  const lines = [
    `对象: ${fn.name}`,
    '类型: 函数 (function)',
    `所属模块: ${moduleName}`,
    `源文件: ${fn.source}`,
    `安全模式: ${fn.security}`,
  ];
  if (fn.permission) lines.push(`权限: ${fn.permission}`);
  if (fn.transaction) lines.push(`事务: ${fn.transaction}`);
  if (fn.audit) lines.push(`审计: ${fn.audit}`);
  if (fn.idempotency) lines.push(`幂等: ${fn.idempotency}`);
  if (fn.tests && fn.tests.length > 0) lines.push(`测试: ${fn.tests.join(', ')}`);
  return lines.join('\n');
}

function describeTrigger(moduleName: string, trigger: TriggerDecl): string {
  return [
    `对象: ${trigger.name}`,
    '类型: 触发器 (trigger)',
    `所属模块: ${moduleName}`,
    `表: ${trigger.table}`,
    `源文件: ${trigger.source}`,
  ].join('\n');
}

function describeGrant(moduleName: string, grant: GrantDecl): string {
  return [
    `对象: ${grant.object}`,
    '类型: 授权 (grant)',
    `所属模块: ${moduleName}`,
    `权限: ${grant.privilege}`,
    `角色: ${grant.role}`,
    `源文件: ${grant.source}`,
  ].join('\n');
}

/**
 * Explains an object by name: policy (name or table.name), function (schema.name),
 * trigger (name), owning table (schema.name), or granted object (schema.name fallback).
 */
export function explainObject(manifest: DatabaseManifest, name: string): string {
  for (const module of manifest.modules) {
    for (const policy of module.policies) {
      if (policy.name === name || `${policy.table}.${policy.name}` === name) {
        return describePolicy(module.name, policy);
      }
    }
    for (const fn of module.functions) {
      if (fn.name === name) return describeFunction(module.name, fn);
    }
    for (const trigger of module.triggers) {
      if (trigger.name === name || `${trigger.table}.${trigger.name}` === name) {
        return describeTrigger(module.name, trigger);
      }
    }
    for (const table of module.tables) {
      if (table === name) {
        return [
          `对象: ${table}`,
          '类型: 表 (table)',
          `所属模块: ${module.name}`,
        ].join('\n');
      }
    }
    for (const grant of module.grants) {
      if (grant.object === name) return describeGrant(module.name, grant);
    }
  }
  return `未找到对象: ${name}`;
}
