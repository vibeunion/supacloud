import { SQL } from "bun";
import { fileURLToPath } from "node:url";

const connection = process.env["SUPACLOUD_COMMAND_TEST_URL"];
if (!connection) throw new Error("SUPACLOUD_COMMAND_TEST_URL is required");
const url = new URL(connection);
if (url.hostname !== "127.0.0.1" || url.pathname !== "/supacloud_commands_test") throw new Error("Unsafe test database");
const sql = new SQL(connection);
try {
  await sql.unsafe(`DO $roles$ BEGIN
    IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
  END $roles$;`);
  for (const name of ["workflows-public", "commands-public"]) {
    const path = fileURLToPath(new URL(`../packages/management-api/src/db/sql-modules/${name}.sql`, import.meta.url));
    await sql.unsafe(await Bun.file(path).text());
  }
  const version: unknown = await sql.unsafe("SELECT version(), extversion FROM pg_extension WHERE extname='pgmq'");
  console.log(version);
} finally { await sql.close(); }
