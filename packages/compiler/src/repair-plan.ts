import type { Diagnostic, DiagnosticFix } from "./types";

export interface DiagnosticRepair {
  code: string;
  errorCode?: string;
  file?: string;
  line?: number;
  type: DiagnosticFix["type"];
  targetFile: string;
  fix: DiagnosticFix;
  readiness: "preview" | "input-required" | "manual";
  reason: string;
}

/**
 * Classifies suggestions without executing them or inferring policy.
 * Preview readiness does not guarantee that source preconditions still hold.
 */
export function createDiagnosticRepairPlan(diagnostics: readonly Diagnostic[]): DiagnosticRepair[] {
  return diagnostics.flatMap((diagnostic): DiagnosticRepair[] => {
    const fix = diagnostic.fix;
    if (!fix) return [];
    return [{
      code: diagnostic.code,
      ...(diagnostic.errorCode === undefined ? {} : { errorCode: diagnostic.errorCode }),
      ...(diagnostic.file === undefined ? {} : { file: diagnostic.file }),
      ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
      type: fix.type,
      targetFile: fix.targetFile,
      fix,
      ...classifyFix(fix),
    }];
  });
}

function classifyFix(fix: DiagnosticFix): Pick<DiagnosticRepair, "readiness" | "reason"> {
  switch (fix.type) {
    case "set_command_mode":
      if (fix.value !== "required" && fix.value !== "none") {
        return { readiness: "input-required", reason: "Choose an explicit transaction or idempotency policy; no policy is inferred." };
      }
      break;
    case "add_command_permission":
      if (!fix.permission?.trim()) {
        return { readiness: "input-required", reason: "Choose an explicit business permission; privileges are never inferred." };
      }
      break;
    case "add_module_import":
      if (!fix.importPath || !fix.symbol) {
        return { readiness: "input-required", reason: "Supply the module import path and exported symbol before previewing." };
      }
      break;
    case "add_route_parameter_binding":
      break;
    default:
      return { readiness: "manual", reason: "The semantic fix executor does not implement this suggestion; edit and verify it manually." };
  }
  return { readiness: "preview", reason: "Preview with the semantic fix executor; source preconditions are checked before writing." };
}
