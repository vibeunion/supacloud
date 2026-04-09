import { sql } from "./src/db/index";
async function run() {
  const p = await sql`SELECT ref, jwt_secret FROM projects LIMIT 1`;
  console.log(JSON.stringify(p));
  process.exit(0);
}
run();
