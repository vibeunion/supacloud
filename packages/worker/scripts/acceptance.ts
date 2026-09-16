import { SQL } from "bun";
import { Flow, extractFlowShape } from "@pgflow/dsl";
import { loadMigrations, renderInstall } from "./migrations.js";
import { renderRoles, renderQueueGrants } from "./roles.js";
import { roleNames, renderSchedule } from "./scheduler.js";
import { acceptanceShape } from "./acceptance-worker.js";

// Explicitly opt in on a test host with local administrative psql access.
const project = process.env.SUPACLOUD_PROJECT_REF ?? "";
const database = process.env.PGDATABASE ?? "";
const central = process.env.PGFLOW_CRON_DATABASE ?? "postgres";
if (process.env.PGFLOW_TEST_ACCEPTANCE !== "1") throw new Error("TEST_ENVIRONMENT_OPT_IN_REQUIRED");
const { worker, job } = roleNames(project);
if (![database, central].every(v => /^[a-zA-Z0-9_-]{1,63}$/.test(v))) throw new Error("DATABASE_REQUIRED");
async function psql(db: string, text: string): Promise<string> {
  const child = Bun.spawn(["sudo", "-u", "postgres", "psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-d", db], {
    stdin: new Blob([text]), stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`ACCEPTANCE_SQL_FAILED: ${err}`);
  return out.trim();
}
async function until(check: () => Promise<boolean>, timeout = 90_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await Bun.sleep(500); }
  throw new Error("ACCEPTANCE_TIMEOUT");
}
const version = Number(await psql(database, "SHOW server_version_num;"));
if (version < 180000) throw new Error("POSTGRESQL_18_REQUIRED");
const initialLogin = await psql(database, `SELECT rolcanlogin FROM pg_roles WHERE rolname='${worker}';`);
if (initialLogin === "t") throw new Error("EXISTING_RUNTIME_LOGIN_REFUSED");
await psql(database, renderInstall(await loadMigrations("shared"), project, database, "shared"));
await psql(database, renderRoles(project));
const shape = extractFlowShape(new Flow<{ operationId: string }>(acceptanceShape).step({ slug: "effect" }, () => null));
const shapeLiteral = JSON.stringify(shape).replaceAll("'", "''");
await psql(database, `
DO $publish$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pgflow.flows WHERE flow_slug='${acceptanceShape.slug}') THEN
    PERFORM pgflow._create_flow_from_shape('${acceptanceShape.slug}','${shapeLiteral}'::jsonb);
  END IF;
END $publish$;
CREATE TABLE IF NOT EXISTS supacloud_worker.acceptance_attempts(operation_id uuid NOT NULL);
CREATE TABLE IF NOT EXISTS supacloud_worker.acceptance_effects(operation_id uuid PRIMARY KEY);
GRANT INSERT ON supacloud_worker.acceptance_attempts,supacloud_worker.acceptance_effects TO ${worker};
GRANT SELECT ON supacloud_worker.acceptance_effects TO ${worker};
GRANT CONNECT ON DATABASE "${database}" TO ${worker};
`);
await psql(database, renderQueueGrants(project));
await psql(central, renderSchedule(project, database, process.env.PGFLOW_CRON_SOCKET));
const password = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const children: ReturnType<typeof Bun.spawn>[] = [];
const diagnostics: Promise<string>[] = [];
let runtime: SQL | undefined;
try {
  await psql(database, `ALTER ROLE ${worker} LOGIN PASSWORD '${password}';`);
  const url = `postgres://${worker}:${password}@127.0.0.1:5432/${database}?sslmode=require`;
  runtime = new SQL(url, { connectionTimeout: 5 });
  for (const statement of ["SELECT * FROM supacloud_worker.migrations", "DELETE FROM pgflow.runs",
    "SELECT pgflow.requeue_stalled_tasks()", "CREATE TABLE public.forbidden(id int)"]) {
    let denied = false;
    try { await runtime.unsafe(statement); } catch { denied = true; }
    if (!denied) throw new Error("RUNTIME_PRIVILEGE_EXCESS");
  }
  const operation = crypto.randomUUID();
  const run = await psql(database, `SELECT run_id FROM pgflow.start_flow('${acceptanceShape.slug}','{"operationId":"${operation}"}'::jsonb);`);
  const spawn = (hold: boolean) => {
    const child = Bun.spawn(["bun", new URL("./acceptance-worker.ts", import.meta.url).pathname], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, SUPACLOUD_PROJECT_REF: project,
        EDGE_WORKER_DB_URL: url, SUPABASE_URL: "http://127.0.0.1:8000",
        SUPABASE_SERVICE_ROLE_KEY: "nonprivileged-sql-only", ACCEPTANCE_HOLD: hold ? "1" : "0",
        ACCEPTANCE_OPERATION: operation },
      stdout: "pipe", stderr: "pipe",
    });
    diagnostics.push(Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      .then(parts => parts.join("\n").replaceAll(password, "[REDACTED]")));
    children.push(child); return child;
  };
  const interrupted = spawn(true);
  await until(async () => {
    if (interrupted.exitCode !== null) throw new Error("ACCEPTANCE_WORKER_EXITED");
    return (await psql(database, `SELECT count(*) FROM supacloud_worker.acceptance_effects WHERE operation_id='${operation}';`)) === "1";
  });
  interrupted.kill("SIGKILL"); await interrupted.exited;
  spawn(false);
  await until(async () => (await psql(database, `SELECT status FROM pgflow.runs WHERE run_id='${run}';`)) === "completed");
  const attempts = await psql(database, `SELECT count(*) FROM supacloud_worker.acceptance_attempts WHERE operation_id='${operation}';`);
  const effects = await psql(database, `SELECT count(*) FROM supacloud_worker.acceptance_effects WHERE operation_id='${operation}';`);
  const broadcasts = await psql(database, `SELECT count(*) FROM realtime.messages WHERE topic='pgflow:run:${run}' AND event='run:completed';`);
  const cron = await psql(central, `SELECT count(*) FROM cron.job_run_details d JOIN cron.job j USING(jobid) WHERE j.jobname='${job}' AND d.status='succeeded';`);
  if (attempts !== "2" || effects !== "1" || broadcasts !== "1" || Number(cron) < 1) throw new Error("ACCEPTANCE_EVIDENCE_MISMATCH");
  console.log(JSON.stringify({ project, database, version, run, attempts: 2, effects: 1, broadcasts: 1, cronSuccesses: Number(cron), leastPrivilege: true }));
} finally {
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.all(children.map(child => child.exited));
  for (const diagnostic of await Promise.all(diagnostics)) console.log(diagnostic);
  await runtime?.close({ timeout: 1 });
  await psql(database, `ALTER ROLE ${worker} NOLOGIN PASSWORD NULL;`);
}
