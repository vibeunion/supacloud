import type { DiagnosticCheck } from "./diagnostics.types";

const checks = new Map<string, DiagnosticCheck>();

export function registerCheck(check: DiagnosticCheck): void {
  checks.set(check.id, check);
}

export function getAllChecks(): DiagnosticCheck[] {
  return [...checks.values()];
}

export function getCheck(id: string): DiagnosticCheck | undefined {
  return checks.get(id);
}
