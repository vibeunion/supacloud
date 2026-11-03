import { SQL } from "bun";
import { runReadOnlySmoke } from "./smoke";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const projectRef = process.env.REYLO_PROJECT_REF ?? "demo";
const db = new SQL(databaseUrl);
try {
  const report = await runReadOnlySmoke(db, projectRef);
  console.log(JSON.stringify(report));
} finally {
  await db.close();
}
