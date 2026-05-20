/**
 * Diagnostics module types.
 * Read-only checks by default; repairs require explicit admin authorization.
 */

export type DiagnosticSeverity = "critical" | "warning" | "info";
export type DiagnosticScope = "platform" | "project";
export type DiagnosticCategory =
  | "database_schema"
  | "database_permissions"
  | "database_functions"
  | "supabase_compat"
  | "api_probe"
  | "service"
  | "configuration"
  | "storage"
  | "queue";

export type ResultStatus = "pass" | "drift" | "missing" | "tampered" | "unreachable" | "degraded" | "error";

export interface DiagnosticCheck {
  id: string;
  name: string;
  description: string;
  category: DiagnosticCategory;
  scope: DiagnosticScope;
  severity: DiagnosticSeverity;
  repairable: boolean;
  /** Run the check. Returns null if skipped (e.g. service not present). */
  run(context: DiagnosticContext): Promise<DiagnosticCheckResult | null>;
  /** Optional repair action. Must be idempotent. */
  repair?(context: DiagnosticContext): Promise<DiagnosticRepairResult>;
}

export interface DiagnosticContext {
  /** Management DB handle */
  metaDb: import("bun").SQL;
  /** Current run scope */
  scope: DiagnosticScope;
  /** Get a project-scoped DB handle (for project-level checks) */
  getProjectDb?(dbName: string): import("bun").SQL;
  /** Project ref (set for project-scoped runs) */
  projectRef?: string;
  /** Read the current trusted hash baseline for a check, if one exists. */
  getBaselineHash?(checkId: string): Promise<string | null>;
  /** Arbitrary shared state between checks in the same run */
  cache: Map<string, unknown>;
}

export interface DiagnosticCheckResult {
  checkId: string;
  status: ResultStatus;
  message: string;
  detail?: string;
  /** Suggested repair description (shown in UI before authorizing repair) */
  repairPreview?: string;
  /** SQL or shell command that would be executed */
  repairCommand?: string;
  /** Extra structured data for audit/logging */
  metadata?: Record<string, unknown>;
}

export interface DiagnosticRepairResult {
  success: boolean;
  message: string;
  /** What was actually done */
  appliedCommand?: string;
}

export interface DiagnosticRun {
  id: string;
  scope: DiagnosticScope;
  projectRef: string | null;
  status: "running" | "completed" | "failed";
  startedAt: Date;
  completedAt: Date | null;
  summary: DiagnosticRunSummary | null;
}

export interface DiagnosticRunSummary {
  total: number;
  pass: number;
  drift: number;
  missing: number;
  tampered: number;
  unreachable: number;
  degraded: number;
  error: number;
}

export interface DiagnosticResultRow {
  id: string;
  runId: string;
  checkId: string;
  status: ResultStatus;
  message: string;
  detail: string | null;
  repairPreview: string | null;
  repairCommand: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}
