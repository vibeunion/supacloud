import { SQL } from "bun";
import { Flow, extractFlowShape } from "@pgflow/dsl";
import { loadMigrations, renderInstall } from "../../scripts/migrations.js";
import { renderRoles, renderQueueGrants } from "../../scripts/roles.js";
import { renderSchedule, roleNames } from "../../scripts/scheduler.js";
import { until } from "./database.js";

export async function sharedDatabaseAcceptance() {
  const name = `supacloud-pgflow-shared-${crypto.randomUUID()}`;
  async function docker(args: string[], text?: string) {
    const p = Bun.spawn(["docker", ...args], { stdin: text === undefined ? "ignore" : new Blob([text]), stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
    if (code !== 0) throw new Error(err + out);
    return out.trim();
  }
  const connections: SQL[] = [];
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const logs: Promise<string>[] = [];
  try {
    await docker(["run","--rm","-d","--name",name,"-p","127.0.0.1::5432",
      "-e","POSTGRES_PASSWORD=fixture", "supacloud-pgflow-test:pg18",
      "-c","shared_preload_libraries=pg_cron","-c","cron.database_name=postgres",
      "-c","cron.use_background_workers=on"]);
    await until(async () => {
      try { await docker(["exec",name,"pg_isready","-h","127.0.0.1","-U","postgres"]); return true; }
      catch { return false; }
    });
    const port = /^127\.0\.0\.1:(\d+)$/.exec(await docker(["port",name,"5432/tcp"]))?.[1];
    if (!port) throw new Error("Loopback port required");
    const base = `postgres://postgres:fixture@127.0.0.1:${port}/`;
    const admin = new SQL(base + "postgres");
    connections.push(admin);
    await admin`CREATE EXTENSION pg_cron`;
    await admin.unsafe("CREATE DATABASE tenant_a");
    await admin.unsafe("CREATE DATABASE tenant_b");
    const apply = (database: string,text: string) => docker(["exec","-i",name,"psql","-X","-U","postgres","-d",database],text);
    const migrations = await loadMigrations("shared");
    const shape = extractFlowShape(new Flow<{operationId:string;fail?:boolean}>({
      slug:"scw_crash_v1",maxAttempts:2,baseDelay:1,timeout:3,
    }).step({slug:"effect"}, () => null));
    for (const database of ["tenant_a","tenant_b"]) {
      const db = new SQL(base + database);
      connections.push(db);
      await db.unsafe(await Bun.file(new URL("./realtime.sql",import.meta.url)).text());
      await db`ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY`;
      await apply(database,renderInstall(migrations,database.replace("_","-"),database,"shared"));
      await db`SELECT pgflow._create_flow_from_shape('scw_crash_v1',${shape}::jsonb)`;
      await apply(database,renderRoles(database.replace("_","-")) + renderQueueGrants(database.replace("_","-")));
      const {worker} = roleNames(database.replace("_","-"));
      await db.unsafe(`CREATE TABLE test_attempts(operation_id uuid NOT NULL,phase text NOT NULL);
        CREATE TABLE test_effects(operation_id uuid PRIMARY KEY);
        GRANT INSERT ON test_attempts,test_effects TO ${worker};
        GRANT SELECT ON test_effects TO ${worker};
        ALTER ROLE ${worker} LOGIN PASSWORD 'fixture-runtime';
        REVOKE CONNECT ON DATABASE ${database} FROM PUBLIC;
        GRANT CONNECT ON DATABASE ${database} TO ${worker};`);
      await apply("postgres",renderSchedule(database.replace("_","-"),database));
      await apply("postgres",renderSchedule(database.replace("_","-"),database));
      const runtime = new SQL(`postgres://${worker}:fixture-runtime@127.0.0.1:${port}/${database}`);
      connections.push(runtime);
      for (const statement of [
        "SELECT * FROM supacloud_worker.migrations",
        "DELETE FROM pgflow.runs",
        "CREATE TABLE public.forbidden(id int)",
        "SELECT pgflow.requeue_stalled_tasks()",
        "SELECT pgflow.delete_flow_and_data('scw_crash_v1')",
      ]) {
        let refused=false;
        try { await runtime.unsafe(statement); } catch { refused=true; }
        if (!refused) throw new Error(`Runtime unexpectedly permitted ${statement}`);
      }
      const [extensions] = await db`SELECT count(*)::int AS n FROM pg_extension WHERE extname IN ('pg_cron','pg_net')`;
      if(extensions.n!==0) throw new Error("Tenant contains scheduler extensions");
      const runInput = {operationId:crypto.randomUUID()};
      const [run] = await db`SELECT run_id FROM pgflow.start_flow('scw_crash_v1',${runInput}::jsonb)`;
      const spawn = (phase?: string) => {
        const p=Bun.spawn(["bun",new URL("./crash-worker.ts",import.meta.url).pathname],{
          env:{...process.env,SUPACLOUD_PROJECT_REF:database.replace("_","-"),SUPABASE_URL:"http://localhost:54321",
            SUPABASE_SERVICE_ROLE_KEY:"nonprivileged-fixture-key",WORKER_NAME:`scw_${database}`,
            WORKER_TEST_DATABASE_URL:`postgres://${worker}:fixture-runtime@127.0.0.1:${port}/${database}`,
            ...(phase?{WORKER_TEST_CRASH_PHASE:phase}:{})},stdout:"pipe",stderr:"pipe",
        });children.push(p);
        logs.push(Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text()]).then(x=>x.join("\n")));
        return p;
      };
      const crash=spawn("after");
      await until(async()=> (await db`SELECT 1 FROM test_effects WHERE operation_id=${runInput.operationId}::uuid`).length===1);
      crash.kill("SIGKILL");await crash.exited;
      const recovered=spawn();
      await until(async()=>{
        const [failure]=await admin`SELECT return_message FROM cron.job_run_details WHERE status='failed' ORDER BY runid DESC LIMIT 1`;
        if(failure)throw new Error(`Central recovery failed: ${failure.return_message}`);
        const [r]=await db`SELECT status FROM pgflow.runs WHERE run_id=${run.run_id}::uuid`;
        return r.status==="completed";
      },90_000);
      recovered.kill("SIGTERM");await recovered.exited;
      const [effect]=await db`SELECT count(*)::int AS n FROM test_effects`;
      const [attempt]=await db`SELECT count(*)::int AS n FROM test_attempts`;
      if(effect.n!==1||attempt.n!==2) throw new Error("Recovery evidence mismatch");
      const [broadcast]=await db`SELECT count(*)::int AS n FROM realtime.messages
        WHERE topic=${"pgflow:run:" + run.run_id} AND event='run:completed'`;
      if(broadcast.n!==1) throw new Error("Runtime Realtime RLS broadcast missing");
    }
    const foreignRole=roleNames("tenant-a").worker;
    const foreign=new SQL(`postgres://${foreignRole}:fixture-runtime@127.0.0.1:${port}/tenant_b`);
    connections.push(foreign);
    let denied=false;
    try { await foreign`SELECT 1`; } catch { denied=true; }
    if(!denied) throw new Error("Cross-tenant database connection permitted");
    const [jobs]=await admin`SELECT count(*)::int AS n FROM cron.job WHERE jobname LIKE 'scw_recover_%'`;
    if(jobs.n!==2) throw new Error("Central scheduling did not isolate tenant jobs");
    const [version]=await admin`SELECT current_setting('server_version_num')::int AS n`;
    if(version.n<180000) throw new Error("PostgreSQL 18 required");
  } catch(error) {
    if(connections[0]) console.error("Central scheduler", await connections[0]`SELECT status,return_message FROM cron.job_run_details ORDER BY runid DESC LIMIT 4`);
    for(const db of connections.slice(1)) {
      try { console.error("Engine",await db`SELECT status,requeued_count,error_message FROM pgflow.step_tasks`); } catch {}
    }
    for(const p of children) if(p.exitCode===null)p.kill("SIGKILL");
    await Promise.all(children.map(p=>p.exited));
    console.error((await Promise.all(logs)).join("\n"));
    throw error;
  } finally {
    for(const p of children) if(p.exitCode===null)p.kill("SIGKILL");
    await Promise.all(children.map(p=>p.exited));
    for(const db of connections)await db.close({timeout:1});
    await docker(["rm","-f",name]);
  }
}
