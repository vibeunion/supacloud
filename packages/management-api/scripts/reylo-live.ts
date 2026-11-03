import { SQL } from "bun";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
await import("reylo/register");
const { runReadOnlySmoke } = await import("../src/db/reylo/smoke");

const projectRef = process.env.REYLO_PROJECT_REF ?? "demo";
const db = new SQL(databaseUrl);
try {
  const report = await runReadOnlySmoke(db, projectRef);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await db.close();
}
