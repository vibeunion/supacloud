/**
 * Diagnostics orchestration service.
 * Runs registered checks, persists results, manages baselines.
 */
import { sql, getProjectDb } from "../db";
import { nanoid } from "nanoid";
import type {
  DiagnosticCheckResult,
  DiagnosticContext,
  DiagnosticRun,
  DiagnosticResultRow,
  DiagnosticRunSummary,
  DiagnosticScope,
} from "./diagnostics.types";
import { getAllChecks, getCheck } from "./diagnostics.registry";
import "../diagnostics/checks/index";

// --- Run orchestration ---

export async function runDiagnostics(
  scope: DiagnosticScope,
  projectRef?: string,
  checkIds?: string[],
): Promise<DiagnosticRun> {
  const runId = nanoid(16);
  const run: DiagnosticRun = {
    id: runId,
    scope,
    projectRef: projectRef ?? null,
    status: "running",
    startedAt: new Date(),
    completedAt: null,
    summary: null,
  };

  await persistRun(run);

  const candidates = getAllChecks().filter((c) => {
    if (c.scope !== scope) return false;
    if (scope === "project" && !projectRef) return false;
    if (checkIds && checkIds.length > 0 && !checkIds.includes(c.id)) return false;
    return true;
  });

  const context = await buildContext(scope, projectRef);
  const results: DiagnosticCheckResult[] = [];

  for (const check of candidates) {
    try {
      const result = await check.run(context);
      if (result) {
        results.push(result);
      }
    } catch (err: unknown) {
      results.push({
        checkId: check.id,
        status: "error",
        message: `Check execution failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const summary = summarizeResults(results);
  run.summary = summary;
  run.completedAt = new Date();
  run.status = "completed";

  await persistRun(run);
  await persistResults(runId, results);

  return run;
}

export async function getRun(runId: string): Promise<DiagnosticRun | null> {
  const rows = await sql`
    SELECT id, scope, project_ref, status, started_at, completed_at, summary
    FROM diagnostic_runs WHERE id = ${runId}
  `;
  if (!rows.length) return null;
  return mapRunRow(rows[0]);
}

export async function listRuns(opts: {
  scope?: DiagnosticScope;
  projectRef?: string;
  limit?: number;
}): Promise<DiagnosticRun[]> {
  const limit = Math.min(opts.limit ?? 20, 100);
  let rows;
  if (opts.scope && opts.projectRef) {
    rows = await sql`
      SELECT id, scope, project_ref, status, started_at, completed_at, summary
      FROM diagnostic_runs
      WHERE scope = ${opts.scope} AND project_ref = ${opts.projectRef}
      ORDER BY started_at DESC LIMIT ${limit}
    `;
  } else if (opts.projectRef) {
    rows = await sql`
      SELECT id, scope, project_ref, status, started_at, completed_at, summary
      FROM diagnostic_runs
      WHERE project_ref = ${opts.projectRef}
      ORDER BY started_at DESC LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT id, scope, project_ref, status, started_at, completed_at, summary
      FROM diagnostic_runs
      ORDER BY started_at DESC LIMIT ${limit}
    `;
  }
  return rows.map(mapRunRow);
}

export async function getRunResults(runId: string): Promise<DiagnosticResultRow[]> {
  const rows = await sql`
    SELECT id, run_id, check_id, status, message, detail, repair_preview, repair_command, metadata, created_at
    FROM diagnostic_results
    WHERE run_id = ${runId}
    ORDER BY created_at ASC
  `;
  return rows.map((r: any) => ({
    id: r.id,
    runId: r.run_id,
    checkId: r.check_id,
    status: r.status,
    message: r.message,
    detail: r.detail,
    repairPreview: r.repair_preview,
    repairCommand: r.repair_command,
    metadata: r.metadata,
    createdAt: new Date(r.created_at),
  }));
}

export async function executeRepair(
  resultId: string,
): Promise<{ success: boolean; message: string }> {
  const [row] = await sql`
    SELECT r.id, r.check_id, r.run_id, r.status, r.repair_command
    FROM diagnostic_results r
    WHERE r.id = ${resultId}
  `;
  if (!row) return { success: false, message: "Result not found" };

  const check = getCheck(row.check_id as string);
  if (!check?.repair) {
    return { success: false, message: "Check does not support repair" };
  }
  if (row.status === "pass") {
    return { success: false, message: "Result is already passing" };
  }

  const [runRow] = await sql`
    SELECT project_ref, scope FROM diagnostic_runs WHERE id = ${row.run_id as string}
  `;
  const context = await buildContext(
    (runRow?.scope === "project" ? "project" : "platform"),
    runRow?.project_ref ? String(runRow.project_ref) : undefined,
  );

  const repairResult = await check.repair(context);

  // Persist repair log
  await sql`
    INSERT INTO diagnostic_repair_logs (result_id, check_id, success, message, applied_command)
    VALUES (${resultId}, ${row.check_id as string}, ${repairResult.success}, ${repairResult.message}, ${repairResult.appliedCommand ?? null})
  `;

  return { success: repairResult.success, message: repairResult.message };
}

// --- Baseline management ---

export async function snapshotBaseline(
  scope: DiagnosticScope,
  projectRef?: string,
): Promise<{ count: number }> {
  const context = await buildContext(scope, projectRef);
  let count = 0;

  for (const check of getAllChecks()) {
    if (check.scope !== scope) continue;
    // Baseline snapshot: run check and store the "expected" state
    // For schema/function checks this captures current hash as the baseline
    try {
      const result = await check.run(context);
      if (!result) continue;

      const expectedStatus = result.metadata?.hash ? "pass" : result.status;

      await sql`
        INSERT INTO diagnostic_baselines (check_id, scope, project_ref, expected_status, expected_hash, snapshot_at)
        VALUES (
          ${check.id}, ${scope}, ${projectRef ?? ""},
          ${expectedStatus}, ${result.metadata?.hash ?? null}, NOW()
        )
        ON CONFLICT (check_id, scope, project_ref) DO UPDATE SET
          expected_status = ${expectedStatus},
          expected_hash = ${result.metadata?.hash ?? null},
          snapshot_at = NOW()
      `;
      count++;
    } catch {
      // Skip checks that fail during baseline
    }
  }

  return { count };
}

// --- Internal helpers ---

async function buildContext(scope: DiagnosticScope, projectRef?: string): Promise<DiagnosticContext> {
  return {
    metaDb: sql,
    scope,
    getProjectDb: (dbName: string) => getProjectDb(dbName),
    projectRef,
    getBaselineHash: async (checkId: string) => {
      const [row] = await sql`
        SELECT expected_hash
        FROM diagnostic_baselines
        WHERE check_id = ${checkId}
          AND scope = ${scope}
          AND project_ref = ${projectRef ?? ""}
        LIMIT 1
      `;
      return row?.expected_hash ? String(row.expected_hash) : null;
    },
    cache: new Map(),
  };
}

function summarizeResults(results: DiagnosticCheckResult[]): DiagnosticRunSummary {
  const summary: DiagnosticRunSummary = {
    total: results.length,
    pass: 0, drift: 0, missing: 0, tampered: 0,
    unreachable: 0, degraded: 0, error: 0,
  };
  for (const r of results) {
    const key = r.status as keyof DiagnosticRunSummary;
    if (key in summary && typeof summary[key] === "number") {
      (summary as any)[key]++;
    }
  }
  return summary;
}

async function persistRun(run: DiagnosticRun): Promise<void> {
  await sql`
    INSERT INTO diagnostic_runs (id, scope, project_ref, status, started_at, completed_at, summary)
    VALUES (${run.id}, ${run.scope}, ${run.projectRef}, ${run.status}, ${run.startedAt}, ${run.completedAt}, ${run.summary ? JSON.stringify(run.summary) : null})
    ON CONFLICT (id) DO UPDATE SET
      status = ${run.status},
      completed_at = ${run.completedAt},
      summary = ${run.summary ? JSON.stringify(run.summary) : null}
  `;
}

async function persistResults(runId: string, results: DiagnosticCheckResult[]): Promise<void> {
  for (const r of results) {
    await sql`
      INSERT INTO diagnostic_results (id, run_id, check_id, status, message, detail, repair_preview, repair_command, metadata)
      VALUES (${nanoid(16)}, ${runId}, ${r.checkId}, ${r.status}, ${r.message}, ${r.detail ?? null}, ${r.repairPreview ?? null}, ${r.repairCommand ?? null}, ${r.metadata ? JSON.stringify(r.metadata) : null})
    `;
  }
}

function mapRunRow(r: any): DiagnosticRun {
  return {
    id: r.id,
    scope: r.scope,
    projectRef: r.project_ref,
    status: r.status,
    startedAt: new Date(r.started_at),
    completedAt: r.completed_at ? new Date(r.completed_at) : null,
    summary: typeof r.summary === "string" ? JSON.parse(r.summary) : r.summary,
  };
}
