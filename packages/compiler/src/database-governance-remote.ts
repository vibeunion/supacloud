import type { DatabaseModule } from "@supacloud/db";

interface RemoteGovernanceContext {
  readonly apiUrl: string;
  readonly apiToken: string;
  readonly projectRef: string;
}

export interface RemoteGovernanceIssue {
  readonly severity: "error" | "warn";
  readonly code: string;
  readonly object: string;
  readonly message: string;
}

export interface RemoteGovernanceReport {
  readonly module: string;
  readonly ok: boolean;
  readonly issues: readonly RemoteGovernanceIssue[];
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REMOTE_TIMEOUT_MS = 30_000;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function remoteContext(environment: NodeJS.ProcessEnv): RemoteGovernanceContext | undefined {
  const apiUrl = environment.SUPACLOUD_API_URL?.trim();
  const apiToken = environment.SUPACLOUD_API_TOKEN?.trim();
  const projectRef = environment.SUPACLOUD_PROJECT_REF?.trim();
  if (!apiUrl || !apiToken || !projectRef) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    return undefined;
  }
  const loopback = parsed.hostname === "localhost"
    || parsed.hostname === "127.0.0.1"
    || parsed.hostname === "[::1]";
  const validProtocol = parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback);
  const exactOrigin = apiUrl === parsed.origin || apiUrl === `${parsed.origin}/`;
  if (!validProtocol || !exactOrigin || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return undefined;
  }
  return { apiUrl: parsed.origin, apiToken, projectRef };
}

function remoteModuleManifest(modules: readonly DatabaseModule[]): Array<Record<string, unknown>> {
  return modules.map((module) => ({
    name: module.name,
    tables: module.tables,
    policies: module.policies.map((policy) => ({
      name: policy.name,
      table: policy.table,
      operation: policy.operation,
      roles: policy.roles,
      ...(policy.usingExpr === undefined ? {} : { usingExpr: policy.usingExpr }),
      ...(policy.checkExpr === undefined ? {} : { checkExpr: policy.checkExpr }),
    })),
    functions: module.functions.map((fn) => ({
      name: fn.name,
      security: fn.security,
      ...(fn.signature === undefined ? {} : { signature: fn.signature }),
    })),
    triggers: module.triggers.map((trigger) => ({
      name: trigger.name,
      table: trigger.table,
      ...(trigger.enabled === undefined ? {} : { enabled: trigger.enabled }),
    })),
    grants: module.grants.map((grant) => ({
      object: grant.object,
      privilege: grant.privilege,
      role: grant.role,
    })),
  }));
}

function parseReports(value: unknown, modules: readonly DatabaseModule[]): RemoteGovernanceReport[] {
  if (!record(value) || typeof value.ok !== "boolean" || !Array.isArray(value.reports)) {
    throw new Error("Management API returned an invalid database governance report.");
  }
  const expectedModules = new Set(modules.map((module) => module.name));
  const reports: RemoteGovernanceReport[] = [];
  for (const rawReport of value.reports) {
    if (!record(rawReport) || !text(rawReport.module) || typeof rawReport.ok !== "boolean"
      || !Array.isArray(rawReport.issues) || !expectedModules.has(rawReport.module)) {
      throw new Error("Management API returned an invalid database governance module report.");
    }
    const issues: RemoteGovernanceIssue[] = [];
    for (const rawIssue of rawReport.issues) {
      if (!record(rawIssue) || (rawIssue.severity !== "error" && rawIssue.severity !== "warn")
        || !text(rawIssue.code) || !text(rawIssue.object) || !text(rawIssue.message)) {
        throw new Error("Management API returned an invalid database governance issue.");
      }
      issues.push({
        severity: rawIssue.severity,
        code: rawIssue.code,
        object: rawIssue.object,
        message: rawIssue.message,
      });
    }
    reports.push({ module: rawReport.module, ok: rawReport.ok, issues });
  }
  if (reports.length !== modules.length || new Set(reports.map((report) => report.module)).size !== reports.length) {
    throw new Error("Management API returned an incomplete database governance report.");
  }
  return reports;
}

/**
 * Reconcile against the tenant Catalog through the platform-owned Management API.
 * The database credential never leaves the Management API process.
 */
export async function reconcileDatabaseModulesRemotely(
  modules: readonly DatabaseModule[],
  schemas: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<RemoteGovernanceReport[]> {
  const context = remoteContext(environment);
  if (!context) {
    throw new Error(
      "SupaCloud platform governance context is unavailable; use the project Management API context, not a database URL.",
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${context.apiUrl}/v1/projects/${encodeURIComponent(context.projectRef)}/database/module-check`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${context.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ modules: remoteModuleManifest(modules), schemas }),
        redirect: "error",
        signal: controller.signal,
      },
    );
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES || !response.ok) {
      throw new Error(`Management API database governance request failed (HTTP ${response.status}).`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error("Management API returned an invalid database governance response.");
    }
    return parseReports(parsed, modules);
  } finally {
    clearTimeout(timeout);
  }
}
