import { SQL } from "bun";
import { loadReyloPilot } from "../src/db/reylo-pilot/index.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (process.env.SUPACLOUD_REYLO_PILOT !== "1") {
  throw new Error("Set SUPACLOUD_REYLO_PILOT=1 to run the Reylo pilot");
}

const pilot = await loadReyloPilot();
if (!pilot) throw new Error("Reylo pilot is disabled");
const { runReadOnlySmoke } = await import("../src/db/reylo-pilot/smoke.ts");

const projectRef = process.env.REYLO_PROJECT_REF ?? "demo";
const db = new SQL(databaseUrl);
try {
  const report = await runReadOnlySmoke(db, projectRef);
  console.log(JSON.stringify({ ...report, pilot_enabled: true }, null, 2));
} finally {
  await db.close();
}
