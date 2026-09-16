import { SQL } from "bun";
import { loadMigrations, renderInstall } from "../../scripts/migrations.js";

async function docker(args: string[], input?: string): Promise<string> {
  const child = Bun.spawn(["docker", ...args], {
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`Fixture docker failed: ${err}\n${out}`);
  return out.trim();
}

export async function until(
  predicate: () => Promise<boolean>,
  milliseconds = 20_000,
): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Fixture condition timed out");
    await Bun.sleep(200);
  }
}

export async function withPgflowDatabase(
  run: (
    sql: SQL,
    url: string,
    install: (project?: string) => Promise<string>,
  ) => Promise<void>,
): Promise<void> {
  const name = `supacloud-pgflow-${crypto.randomUUID()}`;
  let sql: SQL | undefined;
  await docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "--publish",
    "127.0.0.1::5432",
    "--env",
    "POSTGRES_PASSWORD=fixture-local-only",
    "supabase/postgres:17.6.1.136@sha256:f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00",
    "postgres",
    "-c",
    "shared_preload_libraries=pg_cron,pg_net",
    "-c",
    "listen_addresses=*",
    "-c",
    "cron.database_name=postgres",
    "-c",
    "cron.use_background_workers=on",
  ]);
  try {
    await until(async () => {
      try {
        await docker([
          "exec",
          name,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "postgres",
          "-d",
          "postgres",
        ]);
        return true;
      } catch {
        return false;
      }
    }, 60_000);
    const port = /^127\.0\.0\.1:(\d+)$/.exec(
      await docker(["port", name, "5432/tcp"]),
    )?.[1];
    if (!port) throw new Error("Fixture port must be loopback-only");
    const url = `postgres://postgres:fixture-local-only@127.0.0.1:${port}/postgres`;
    // The image's postgres login is intentionally not a superuser. This disposable
    // installation test uses installer privileges; it is not a least-privilege test.
    await docker([
      "exec",
      name,
      "psql",
      "-X",
      "-U",
      "supabase_admin",
      "-d",
      "postgres",
      "-c",
      "ALTER ROLE postgres SUPERUSER",
    ]);
    sql = new SQL(url, { max: 4, connectionTimeout: 5 });
    await sql.unsafe(
      await Bun.file(new URL("./realtime.sql", import.meta.url)).text(),
    );
    await sql.unsafe(`
      CREATE EXTENSION IF NOT EXISTS supabase_vault CASCADE;
      CREATE TABLE test_attempts(operation_id uuid NOT NULL, phase text NOT NULL, created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE test_effects(operation_id uuid PRIMARY KEY, created_at timestamptz DEFAULT clock_timestamp());
    `);
    const migrations = await loadMigrations();
    // Fail at the very end of a real installation, then prove its earlier DDL
    // and receipts were rolled back before doing the successful installation.
    const broken = migrations.map((migration, index) =>
      index === migrations.length - 1
        ? {
            ...migration,
            sql: `${migration.sql}\nSELECT supacloud_missing_install_function();`,
          }
        : migration,
    );
    let failed = false;
    try {
      await docker(
        ["exec", "-i", name, "psql", "-X", "-U", "postgres", "-d", "postgres"],
        renderInstall(broken, "fixture", "postgres"),
      );
    } catch {
      failed = true;
    }
    const [rollback] = await sql`SELECT to_regnamespace('pgflow') IS NULL
      AND to_regnamespace('supacloud_worker') IS NULL AS clean`;
    if (!failed || !rollback.clean)
      throw new Error("Installation did not roll back atomically");
    const install = (project = "fixture") =>
      docker(
        ["exec", "-i", name, "psql", "-X", "-U", "postgres", "-d", "postgres"],
        renderInstall(migrations, project, "postgres"),
      );
    await install();
    await run(sql, url, install);
  } catch (error) {
    console.error(await docker(["logs", "--tail", "35", name]));
    throw error;
  } finally {
    await sql?.close({ timeout: 1 });
    await docker(["rm", "--force", name]);
  }
}
