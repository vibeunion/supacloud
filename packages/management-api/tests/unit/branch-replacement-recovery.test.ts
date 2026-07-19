import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const indexSource = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
const databaseRouteSource = readFileSync(new URL("../../src/routes/database.ts", import.meta.url), "utf8");
const branchServiceSource = readFileSync(new URL("../../src/services/branch.service.ts", import.meta.url), "utf8");
const workerSource = readFileSync(
  new URL("../../src/workers/branch-replacement-recovery.worker.ts", import.meta.url),
  "utf8",
);

describe("branch replacement crash recovery", () => {
  test("awaits the initial recovery sweep before accepting HTTP traffic", () => {
    const recoveryIndex = indexSource.indexOf("await recoverDatabaseReplacementsBeforeServe()");
    const serveIndex = indexSource.indexOf("Bun.serve({");

    expect(recoveryIndex).toBeGreaterThan(-1);
    expect(serveIndex).toBeGreaterThan(recoveryIndex);
  });

  test("retries pending recovery and blocks normal migration entrypoints", () => {
    expect(workerSource).toContain("setInterval");
    expect(workerSource).toContain("recoverInterruptedReplacements");
    expect(databaseRouteSource).toContain("branchReplacementJournal.assertInactive([input.projectRef])");
    expect(databaseRouteSource).toContain("branchReplacementJournal.assertInactive([params.ref])");
    expect(branchServiceSource.match(/branchReplacementJournal\.assertInactive/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
