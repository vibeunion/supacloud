/**
 * Plan: Compiles repeatable SQL objects declared by modules (functions/policies/triggers/grants) into ordered execution plans.
 * Boundary: Handles repeatable objects only; table schema migrations continue forward migrations.
 */

import { lintSql } from './lint.js';
import type { DatabaseModule } from './module.js';

export interface PlanStep {
  kind: 'function' | 'policy' | 'trigger' | 'grant';
  /** Object identifier: functions use schema-qualified name; policies/triggers use table.name; grants use object:privilege:role */
  name: string;
  /** Relative module path */
  source: string;
  /** Source file content hash */
  sha256: string;
  sql: string;
  risk: Array<{ severity: 'error' | 'warn'; code: string; message: string }>;
}

export interface ModulePlan {
  version: 1;
  module: string;
  createdAt: string;
  /** Dependency order: function -> policy -> trigger -> grant */
  steps: PlanStep[];
  /** Combined hash of all step sha256 hashes */
  digest: string;
}

/** WebCrypto SHA-256 (global crypto available in Node/Bun), returns lowercase hex */
async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function planModule(
  module: DatabaseModule,
  readFile: (path: string) => Promise<string>,
): Promise<ModulePlan> {
  // The same source file may be referenced by multiple declarations; cache by path to avoid re-reading
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
      // Reuse lintSql static analysis results as step risks (error-level lint preserves severity=error)
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
