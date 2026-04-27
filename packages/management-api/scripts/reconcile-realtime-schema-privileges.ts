import { config } from "../src/config";
import { sql } from "../src/db";
import { logger } from "../src/utils/logger";

type ProjectRow = {
  ref: string;
  db_name: string | null;
  db_user: string | null;
};

function adminDatabaseUrl(dbName: string): string {
  const url = new URL(config.databaseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function resolveProjectDbName(project: ProjectRow): string {
  return project.db_name || `supa_${project.ref}`;
}

async function databaseExists(dbName: string): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_database WHERE datname = ${dbName}
    ) AS exists
  `;
  return Boolean(rows[0]?.exists);
}

async function runPsql(dbName: string, sqlText: string) {
  const proc = Bun.spawn(
    [
      "psql",
      adminDatabaseUrl(dbName),
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sqlText,
    ],
    {
      env: {
        ...process.env,
        PGPASSWORD: config.pgPassword || process.env.PGPASSWORD || "",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(stderr || stdout || `psql exited with code ${exitCode}`);
  }

  return stdout;
}

async function reconcileProject(project: ProjectRow) {
  const dbName = resolveProjectDbName(project);
  const roleName = project.db_user || `role_${project.ref}`;

  const statements = [
    `CREATE SCHEMA IF NOT EXISTS realtime AUTHORIZATION supabase_admin;`,
    `GRANT USAGE, CREATE ON SCHEMA realtime TO "${roleName}";`,
    `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA realtime TO "${roleName}";`,
    `GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA realtime TO "${roleName}";`,
    `GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA realtime TO "${roleName}";`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA realtime GRANT ALL PRIVILEGES ON TABLES TO "${roleName}";`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA realtime GRANT ALL PRIVILEGES ON SEQUENCES TO "${roleName}";`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA realtime GRANT ALL PRIVILEGES ON ROUTINES TO "${roleName}";`,
    `DO $$
     BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
         CREATE PUBLICATION supabase_realtime;
       END IF;

       IF to_regclass('public.tasks') IS NOT NULL THEN
         ALTER TABLE public.tasks REPLICA IDENTITY FULL;

         IF NOT EXISTS (
           SELECT 1
           FROM pg_publication_tables
           WHERE pubname = 'supabase_realtime'
             AND schemaname = 'public'
             AND tablename = 'tasks'
         ) THEN
           ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks;
         END IF;
       END IF;
     EXCEPTION
       WHEN duplicate_object THEN NULL;
       WHEN insufficient_privilege THEN NULL;
       WHEN undefined_table THEN NULL;
       WHEN OTHERS THEN NULL;
     END $$;`,
  ];

  await runPsql(dbName, statements.join("\n"));
  logger.info("[RealtimeSchemaReconcile] privileges ensured", {
    projectRef: project.ref,
    dbName,
    roleName,
  });
}

async function main() {
  const rows = await sql<ProjectRow[]>`
    SELECT ref, db_name, db_user
    FROM projects
    WHERE status IS NULL OR status <> 'deleted'
    ORDER BY ref
  `;

  logger.info("[RealtimeSchemaReconcile] scanning projects", {
    total: rows.length,
  });

  const failures: Array<{ ref: string; error: string }> = [];
  const skipped: Array<{ ref: string; dbName: string; reason: string }> = [];

  for (const row of rows) {
    try {
      const dbName = resolveProjectDbName(row);
      if (!(await databaseExists(dbName))) {
        skipped.push({
          ref: row.ref,
          dbName,
          reason: "tenant database does not exist",
        });
        logger.warn("[RealtimeSchemaReconcile] skipped missing tenant database", {
          projectRef: row.ref,
          dbName,
        });
        continue;
      }

      await reconcileProject(row);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      failures.push({ ref: row.ref, error: message });
      logger.error("[RealtimeSchemaReconcile] failed", {
        projectRef: row.ref,
        error: message,
      });
    }
  }

  logger.info("[RealtimeSchemaReconcile] complete", {
    total: rows.length,
    skipped: skipped.length,
    failed: failures.length,
  });

  if (skipped.length > 0) {
    console.warn(JSON.stringify({ skipped }, null, 2));
  }

  if (failures.length > 0) {
    console.error(JSON.stringify({ failures }, null, 2));
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    logger.error("[RealtimeSchemaReconcile] fatal", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
