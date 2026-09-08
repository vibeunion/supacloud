import { readProjectRestoreDrill, runProjectRestoreDrill } from "../packages/management-api/src/services/project-restore-drill";

const [operation, drillId, confirmation] = process.argv.slice(2);
try {
  if (operation === "status" && drillId && !confirmation) {
    console.log(JSON.stringify(await readProjectRestoreDrill(drillId)));
  } else if (operation === "run" && drillId && confirmation) {
    const receipt = await runProjectRestoreDrill(drillId, confirmation);
    console.log(JSON.stringify(receipt));
    if (receipt.status !== "succeeded") process.exitCode = 1;
  } else {
    console.error("Usage: project-restore-drill.ts run <uuid> <confirmation> | status <uuid>");
    process.exitCode = 2;
  }
} catch {
  console.error("Restore drill refused or outcome unknown; inspect the signed receipt before any new attempt.");
  process.exitCode = 1;
}
