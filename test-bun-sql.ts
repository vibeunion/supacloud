import { SQL } from "bun";
const url = "postgresql://postgres:postgres@localhost:5432/postgres";
const sql = new SQL(url);

const config = {};
try {
  const result = await sql`SELECT ${config ? JSON.stringify(config) : "{}"}::jsonb as json_val`;
  console.log("SUCCESS:", result);
} catch (e) {
  console.error("ERROR:", e);
}
