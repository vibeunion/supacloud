import type { Diagnostic } from "./types";
import { createDiagnosticRepairPlan } from "./repair-plan";
import type { DiagnosticRepair } from "./repair-plan";

/** Shared source for CLI JSON consumers, editor diagnostics and AI repair tools. */
export interface DiagnosticReportEntry {
  diagnostic: Diagnostic;
  repair?: DiagnosticRepair;
  guidance?: string;
}
export interface DiagnosticReport { format: 1; entries: DiagnosticReportEntry[]; }
export function createDiagnosticReport(diagnostics: readonly Diagnostic[]): DiagnosticReport {
  return { format: 1, entries: diagnostics.map(diagnostic => {
    const repair = createDiagnosticRepairPlan([diagnostic])[0];
    return {
      diagnostic: { ...diagnostic },
      ...(repair ? { repair } : {}),
      ...(diagnostic.suggestion ? { guidance: diagnostic.suggestion } : {}),
    };
  }) };
}

/** LSP-shaped data only. It neither starts a language server nor applies unreviewed edits. */
export function toEditorDiagnostics(diagnostics: readonly Diagnostic[]) {
  return createDiagnosticReport(diagnostics).entries.map(entry => ({
    range: {
      start: {
        line: Math.max(0, (entry.diagnostic.line ?? 1) - 1),
        character: Math.max(0, entry.diagnostic.column ?? 0),
      },
      end: {
        line: Math.max(0, (entry.diagnostic.endLine ?? entry.diagnostic.line ?? 1) - 1),
        character: Math.max(0, entry.diagnostic.endColumn ?? entry.diagnostic.column ?? 0),
      },
    },
    severity: entry.diagnostic.severity === "error" ? 1 as const : 2 as const,
    source: "supacloud",
    code: entry.diagnostic.errorCode ?? entry.diagnostic.code,
    ...(entry.diagnostic.docsUrl ? { codeDescription: { href: entry.diagnostic.docsUrl } } : {}),
    message: entry.diagnostic.message + (entry.guidance ? `\n${entry.guidance}` : ""),
    data: { format: 1 as const, ...entry },
  }));
}

/** Semantic editor commands are emitted only after a successful read-only preview.
 * Consumers execute the command through applyDiagnosticFix with expectedSourceHash;
 * source drift or changed semantic preconditions reject the action.
 */
export async function createEditorCodeActions(diagnostics: readonly Diagnostic[], options: { rootDir?: string } = {}) {
  const { applyDiagnosticFix } = await import("./fixes");
  const actions: Array<{
    title: string;
    kind: "quickfix";
    command: { title: string; command: "supacloud.applyDiagnosticFix";
      arguments: [{ fix: NonNullable<Diagnostic["fix"]>; expectedSourceHash: string }] };
    data: { file: string; preview: string };
  }> = [];
  for (const entry of createDiagnosticReport(diagnostics).entries) {
    if (entry.repair?.readiness !== "preview") continue;
    try {
      const preview = await applyDiagnosticFix(entry.repair.fix, { ...options, dryRun: true });
      if (!preview.changed) continue;
      const title = `Apply ${entry.repair.type}`;
      actions.push({ title, kind: "quickfix", command: {
        title, command: "supacloud.applyDiagnosticFix",
        arguments: [{ fix: entry.repair.fix, expectedSourceHash: preview.sourceHash }],
      }, data: { file: preview.file, preview: preview.content } });
    } catch {
      // Stale, ambiguous or unsupported suggestions remain diagnostics only.
    }
  }
  return actions;
}
