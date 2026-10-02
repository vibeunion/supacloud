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
      start: { line: Math.max(0, (entry.diagnostic.line ?? 1) - 1), character: 0 },
      end: { line: Math.max(0, (entry.diagnostic.line ?? 1) - 1), character: 0 },
    },
    severity: entry.diagnostic.severity === "error" ? 1 as const : 2 as const,
    source: "supacloud",
    code: entry.diagnostic.errorCode ?? entry.diagnostic.code,
    ...(entry.diagnostic.docsUrl ? { codeDescription: { href: entry.diagnostic.docsUrl } } : {}),
    message: entry.diagnostic.message + (entry.guidance ? `\n${entry.guidance}` : ""),
    data: { format: 1 as const, ...entry },
  }));
}
