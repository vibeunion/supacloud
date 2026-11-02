import type { SQL } from "bun";
import {
  readCatalog,
  reconcileModule,
  type DatabaseModule,
  type PolicyOperation,
  type QueryExecutor,
  type ReconcileReport,
} from "@supacloud/db";

const MAX_MODULES = 64;
const MAX_ENTRIES = 1024;
const MAX_TABLES = 512;
const MAX_TEXT = 512;

const POLICY_OPERATIONS = new Set<PolicyOperation>(["select", "insert", "update", "delete", "all"]);

export class DatabaseModuleCheckInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseModuleCheckInputError";
  }
}

function fail(message: string): never {
  throw new DatabaseModuleCheckInputError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maxLength = MAX_TEXT): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    fail(`${label} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function optionalText(value: unknown, label: string, maxLength = MAX_TEXT): string | undefined {
  if (value === undefined) return undefined;
  return text(value, label, maxLength);
}

function optionalNullableText(value: unknown, label: string, maxLength = MAX_TEXT): string | null | undefined {
  if (value === null) return null;
  return optionalText(value, label, maxLength);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") fail(`${label} must be a boolean`);
  return value;
}

function list(value: unknown, label: string, maxItems: number): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  if (value.length > maxItems) fail(`${label} must contain at most ${maxItems} entries`);
  return value;
}

function stringList(value: unknown, label: string, maxItems: number): string[] {
  return list(value, label, maxItems).map((entry, index) => text(entry, `${label}[${index}]`));
}

function objectList(value: unknown, label: string, maxItems: number): Record<string, unknown>[] {
  return list(value, label, maxItems).map((entry, index) => record(entry, `${label}[${index}]`));
}

function policyOperation(value: unknown, label: string): PolicyOperation {
  if (typeof value !== "string" || !POLICY_OPERATIONS.has(value as PolicyOperation)) {
    fail(`${label} must be select, insert, update, delete or all`);
  }
  return value as PolicyOperation;
}

function normalizeModule(value: unknown, index: number): DatabaseModule {
  const label = `modules[${index}]`;
  const entry = record(value, label);
  const name = text(entry["name"], `${label}.name`, 128);
  const tables = stringList(entry["tables"] ?? [], `${label}.tables`, MAX_TABLES);
  const policies = objectList(entry["policies"] ?? [], `${label}.policies`, MAX_ENTRIES).map((policy, policyIndex) => {
    const policyLabel = `${label}.policies[${policyIndex}]`;
    return {
      name: text(policy["name"], `${policyLabel}.name`, 128),
      table: text(policy["table"], `${policyLabel}.table`, 256),
      operation: policyOperation(policy["operation"], `${policyLabel}.operation`),
      roles: stringList(policy["roles"], `${policyLabel}.roles`, 64),
      source: "management-api",
      ...(policy["usingExpr"] === undefined ? {} : { usingExpr: optionalNullableText(policy["usingExpr"], `${policyLabel}.usingExpr`) }),
      ...(policy["checkExpr"] === undefined ? {} : { checkExpr: optionalNullableText(policy["checkExpr"], `${policyLabel}.checkExpr`) }),
    };
  });
  const functions = objectList(entry["functions"] ?? [], `${label}.functions`, MAX_ENTRIES).map((fn, fnIndex) => {
    const fnLabel = `${label}.functions[${fnIndex}]`;
    const security = fn["security"];
    if (security !== "invoker" && security !== "definer") {
      fail(`${fnLabel}.security must be invoker or definer`);
    }
    return {
      name: text(fn["name"], `${fnLabel}.name`, 256),
      source: "management-api",
      security: security as "invoker" | "definer",
      ...(fn["signature"] === undefined ? {} : { signature: text(fn["signature"], `${fnLabel}.signature`, 512) }),
    };
  });
  const triggers = objectList(entry["triggers"] ?? [], `${label}.triggers`, MAX_ENTRIES).map((trigger, triggerIndex) => {
    const triggerLabel = `${label}.triggers[${triggerIndex}]`;
    return {
      name: text(trigger["name"], `${triggerLabel}.name`, 128),
      table: text(trigger["table"], `${triggerLabel}.table`, 256),
      source: "management-api",
      ...(trigger["enabled"] === undefined ? {} : { enabled: optionalBoolean(trigger["enabled"], `${triggerLabel}.enabled`) }),
    };
  });
  const grants = objectList(entry["grants"] ?? [], `${label}.grants`, MAX_ENTRIES).map((grant, grantIndex) => {
    const grantLabel = `${label}.grants[${grantIndex}]`;
    return {
      object: text(grant["object"], `${grantLabel}.object`, 256),
      privilege: text(grant["privilege"], `${grantLabel}.privilege`, 64),
      role: text(grant["role"], `${grantLabel}.role`, 64),
      source: "management-api",
    };
  });
  if (tables.length === 0 && functions.length === 0) {
    fail(`${label} must declare at least one table or function`);
  }
  return { name, tables, policies, functions, triggers, grants };
}

/** Validate the JSON-safe module subset accepted by the remote Catalog check. */
export function normalizeGovernanceModules(value: unknown): DatabaseModule[] {
  const modules = list(value, "modules", MAX_MODULES);
  if (modules.length === 0) fail("modules must contain at least one module");
  const normalized = modules.map(normalizeModule);
  if (new Set(normalized.map((module) => module.name)).size !== normalized.length) {
    fail("modules must have unique names");
  }
  return normalized;
}

/** Reconcile declared modules against the selected tenant Catalog schemas. */
export async function runDatabaseModuleCheck(
  projectDb: Pick<SQL, "unsafe" | "array">,
  modules: readonly DatabaseModule[],
  schemas: readonly string[],
): Promise<{ ok: boolean; reports: ReconcileReport[] }> {
  const executor: QueryExecutor = {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      const values = (params ?? []).map((value) => {
        if (!Array.isArray(value)) return value;
        if (!value.every((item): item is string => typeof item === "string")) {
          fail("Catalog schema parameters must be strings");
        }
        return projectDb.array(value, "TEXT");
      });
      return await projectDb.unsafe(sql, values) as T[];
    },
  };
  const catalog = await readCatalog(executor, [...schemas]);
  const reports = modules.map((module) => reconcileModule(module, catalog));
  return { ok: reports.every((report) => report.ok), reports };
}