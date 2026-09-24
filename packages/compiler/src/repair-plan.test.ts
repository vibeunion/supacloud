import { describe, expect, test } from "bun:test";
import { createDiagnosticRepairPlan } from "./repair-plan";
import type { Diagnostic, DiagnosticFix } from "./types";

function diagnostic(fix: DiagnosticFix): Diagnostic {
  return { severity: "error", code: "test", errorCode: "SC4012", file: "src/app.ts", line: 3, message: "test", fix };
}

describe("diagnostic repair plan", () => {
  test("keeps executable payloads and source locations without mutating diagnostics", () => {
    const fix: DiagnosticFix = {
      type: "add_route_parameter_binding", targetFile: "src/app.ts",
      controller: "Controller", route: "get", parameter: "id", binding: "param",
    };
    const input = diagnostic(fix);
    const before = JSON.stringify(input);
    expect(createDiagnosticRepairPlan([input])).toEqual([{
      code: "test", errorCode: "SC4012", file: "src/app.ts", line: 3,
      type: fix.type, targetFile: fix.targetFile, fix,
      readiness: "preview", reason: expect.any(String),
    }]);
    expect(JSON.stringify(input)).toBe(before);
  });

  test("never infers governance policies or permissions", () => {
    const mode: DiagnosticFix = {
      type: "set_command_mode", targetFile: "src/app.ts", command: "Approve",
      property: "transaction", expectedExpression: '"sometimes"',
    };
    const permission: DiagnosticFix = {
      type: "add_command_permission", targetFile: "src/app.ts", command: "Approve", module: "case",
    };
    for (const fix of [mode, permission, { ...permission, permission: "  " }]) {
      expect(createDiagnosticRepairPlan([diagnostic(fix)])[0]!.readiness).toBe("input-required");
    }
    for (const fix of [
      { ...mode, value: "required" as const },
      { ...mode, value: "none" as const },
      { ...permission, permission: "case.approve" },
    ]) {
      expect(createDiagnosticRepairPlan([diagnostic(fix)])[0]!.readiness).toBe("preview");
    }
    expect(mode.value).toBeUndefined();
    expect(permission.permission).toBeUndefined();
  });

  test("module wiring requires a concrete import path and symbol", () => {
    const fix: DiagnosticFix = { type: "add_module_import", targetFile: "src/app.ts", module: "audit" };
    for (const partial of [fix, { ...fix, symbol: "AuditModule" }, { ...fix, importPath: "./audit" }]) {
      expect(createDiagnosticRepairPlan([diagnostic(partial)])[0]!.readiness).toBe("input-required");
    }
    expect(createDiagnosticRepairPlan([diagnostic({
      ...fix, symbol: "AuditModule", importPath: "./audit",
    })])[0]!.readiness).toBe("preview");
  });

  test("suggestions not implemented by the executor remain manual", () => {
    const fixes: DiagnosticFix[] = [
      { type: "add_provider", targetFile: "src/app.ts", token: "Store", module: "case" },
      { type: "mark_optional_dependency", targetFile: "src/app.ts", owner: "Service", token: "Store" },
      { type: "change_provider_scope", targetFile: "src/app.ts", provider: "Store", from: "request", to: "application" },
      { type: "remove_route_body_binding", targetFile: "src/app.ts", controller: "Controller", route: "get" },
    ];
    expect(createDiagnosticRepairPlan(fixes.map(diagnostic)).map((entry) => entry.readiness))
      .toEqual(["manual", "manual", "manual", "manual"]);
  });

  test("diagnostics without semantic suggestions do not invent fixes", () => {
    expect(createDiagnosticRepairPlan([{ severity: "warn", code: "test", message: "manual investigation" }])).toEqual([]);
  });
});
