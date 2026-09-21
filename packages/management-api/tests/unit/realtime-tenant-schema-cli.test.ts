import { describe, expect, test } from "bun:test";
import { parseArgs } from "../../scripts/reconcile-realtime-tenant-schema";

describe("Realtime tenant schema CLI arguments", () => {
  test("returns action-specific required parameters", () => {
    const inspect = parseArgs(["inspect", "--project-ref", "proj_1"]);
    if (inspect.action !== "inspect") throw new Error("Expected inspect arguments");
    expect(inspect.projectRef).toBe("proj_1");

    const plan = parseArgs(["plan", "--project-ref", "proj_1", "--out", "/tmp/plan.json"]);
    if (plan.action !== "plan") throw new Error("Expected plan arguments");
    expect(plan.projectRef).toBe("proj_1");
    expect(plan.outputPath).toBe("/tmp/plan.json");

    const apply = parseArgs(["apply", "--plan-file", "/tmp/plan.json", "--dry-run"]);
    if (apply.action !== "apply") throw new Error("Expected apply arguments");
    expect(apply.planPath).toBe("/tmp/plan.json");
    expect(apply.dryRun).toBe(true);
    expect(apply.allowDestructive).toBe(false);
    expect(apply.backupReceiptPath).toBeUndefined();
  });

  test("preserves explicit runtime and reviewed apply options", () => {
    expect(parseArgs([
      "apply", "--plan-file", "/tmp/plan.json",
      "--backup-receipt", "/tmp/backup.json", "--allow-destructive",
      "--runtime", "docker", "--container", "test-realtime",
      "--release-command", "/app/bin/realtime",
    ])).toEqual({
      action: "apply", planPath: "/tmp/plan.json",
      backupReceiptPath: "/tmp/backup.json", allowDestructive: true, dryRun: false,
      runtime: "docker", container: "test-realtime", releaseCommand: "/app/bin/realtime",
    });
  });

  test.each([
    { args: [], error: "Usage:" },
    { args: ["delete"], error: "Usage:" },
    { args: ["inspect"], error: "inspect requires --project-ref" },
    { args: ["plan"], error: "plan requires --project-ref" },
    { args: ["plan", "--project-ref", "proj_1"], error: "plan requires --out" },
    { args: ["apply"], error: "apply requires --plan-file" },
    { args: ["inspect", "--project-ref"], error: "missing value for --project-ref" },
    { args: ["inspect", "--project-ref", ""], error: "missing value for --project-ref" },
    { args: ["inspect", "--project-ref", "--dry-run"], error: "missing value for --project-ref" },
    { args: ["inspect", "--unknown"], error: "unknown option: --unknown" },
    {
      args: ["inspect", "--project-ref", "proj_1", "--project-ref", "proj_2"],
      error: "duplicate option: --project-ref",
    },
    { args: ["inspect", "--project-ref", "proj_1", "--dry-run"], error: "--dry-run is only valid with apply" },
    {
      args: ["plan", "--project-ref", "proj_1", "--out", "/tmp/plan.json", "--dry-run"],
      error: "--dry-run is only valid with apply",
    },
  ])("rejects $args before constructing a reconciliation service", ({ args, error }) => {
    expect(() => parseArgs(args)).toThrow(error);
  });
});
