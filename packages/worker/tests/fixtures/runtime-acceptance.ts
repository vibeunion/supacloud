import { expect } from "bun:test";
import { SQL } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { withPgflowDatabase, until } from "./database.js";
import { renderAdmissionInstall } from "../../scripts/admission.js";
import { renderRoles } from "../../scripts/roles.js";
import { roleNames } from "../../scripts/scheduler.js";
import { submitReport, downloadReport, LocalArtifacts, reportHandler } from "../../examples/reporting/report.js";
import { submitBoundedTask } from "../../src/admission.js";
import { createWorkerTelemetry } from "../../src/telemetry.js";
import { evaluateWorkerPerformance } from "../../src/performance.js";
import { normalizeAccounting } from "../../src/native.js";

async function command(args: string[]): Promise<string> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`ACCEPTANCE_COMMAND_FAILED: ${args[0]} ${err.slice(0, 1500)}`);
  return (args[0] === "docker" && args[1] === "logs" ? out + err : out).trim();
}

async function sampleApi(url: string, seconds: number) {
  const startedAtMs = Date.now();
  const latenciesMs: number[] = [];
  const databaseMs: (number | null)[] = [];
  const arrivalDelayMs: number[] = [];
  let errors = 0;
  const pending: Promise<void>[] = [];
  // Fixed offered arrivals, not a closed loop that slows its input when requests stall.
  for (let index = 0; index < seconds * 50; index++) {
    await Bun.sleep(Math.max(0, startedAtMs + index * 20 - Date.now()));
    pending.push((async () => {
      const start = performance.now();
      arrivalDelayMs.push(Math.max(0, Date.now() - (startedAtMs + index * 20)));
      let databaseDuration: number | null = null;
      try {
        const result = await fetch(url, {
          headers: { authorization: "Bearer fixture-api-only" }, signal: AbortSignal.timeout(2000),
        });
        const measured = result.headers.get("x-fixture-database-ms");
        if (measured !== null && Number.isFinite(Number(measured))) databaseDuration = Number(measured);
        if (!result.ok) errors++;
        await result.arrayBuffer();
      } catch { errors++; }
      latenciesMs.push(Math.max(0.001, performance.now() - start));
      databaseMs.push(databaseDuration);
    })());
  }
  await Promise.all(pending);
  await Bun.sleep(Math.max(0, startedAtMs + seconds * 1000 - Date.now()));
  return { startedAtMs, seconds: (Date.now() - startedAtMs) / 1000, latenciesMs, databaseMs, arrivalDelayMs, errors };
}

export async function runtimeAcceptance() {
  const artifactsDirectory = await mkdtemp(join(tmpdir(), "scw-runtime-"));
  const packageDirectory = resolve(import.meta.dir, "../..");
  const names: string[] = [];
  let report: unknown;
  let accepted = false;
  try {
    await withPgflowDatabase(async (sql, url, _install, psql) => {
      await psql(await renderAdmissionInstall("fixture"));
      await sql.unsafe(await Bun.file(new URL("../../examples/reporting/schema.sql", import.meta.url)).text());
      await sql`SELECT pgmq.create('scw_reports')`;
      await sql`SELECT pgmq.create('scw_other')`;
      await sql`INSERT INTO supacloud_worker.admission_limits(scope,max_pending,max_per_second)
        VALUES ('project',3,1000),('scw_reports',2,1000),('scw_other',2,1000)`;
      const source = crypto.randomUUID();
      await sql`INSERT INTO report_demo.sources VALUES (${source},'v1','operator',false)`;
      await sql`INSERT INTO report_demo.rows
        SELECT ${source}::uuid,n,'label-'||n,9007199254740993::bigint FROM generate_series(1,10000) n`;
      await sql`UPDATE report_demo.sources SET frozen=true WHERE id=${source}`;
      await expect(Promise.resolve(sql`UPDATE report_demo.rows SET label='bad' WHERE source_id=${source} AND row_id=1`))
        .rejects.toThrow("REPORT_SOURCE_IMMUTABLE");
      const submitted = await Promise.allSettled(Array.from({ length: 12 }, () =>
        submitReport(sql, "fixture", "operator", crypto.randomUUID(), source, "v1")));
      const admitted = submitted.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      expect(admitted).toHaveLength(2);
      expect((await sql`SELECT count(*)::int n FROM report_demo.requests`)[0].n).toBe(2);
      expect((await submitReport(sql, "fixture", "operator", admitted[0]!.value, source, "v1")).replay).toBe(true);
      const other = () => submitBoundedTask(sql, {
        projectRef: "fixture", queueName: "scw_other", taskKey: "other",
      }, async () => ({ replay: false, value: null, idempotencyKey: crypto.randomUUID(), input: {} }));
      await other();
      await expect(other()).rejects.toThrow("WORKER_PROJECT_FULL");
      await sql`SELECT pgmq.purge_queue('scw_reports')`;
      await sql`SELECT pgmq.purge_queue('scw_other')`;
      await sql`DELETE FROM report_demo.requests`;
      await sql`UPDATE supacloud_worker.admission_limits SET max_pending=500,used=0,window_start='-infinity',
        max_per_second=CASE WHEN scope='scw_reports' THEN 1 ELSE 1000 END`;
      await submitReport(sql, "fixture", "operator", crypto.randomUUID(), source, "v1");
      await expect(submitReport(sql, "fixture", "operator", crypto.randomUUID(), source, "v1"))
        .rejects.toThrow("WORKER_RATE_LIMITED");
      expect((await sql`SELECT count(*)::int n FROM report_demo.requests`)[0].n).toBe(1);
      await sql`SELECT pgmq.purge_queue('scw_reports')`;
      await sql`DELETE FROM report_demo.requests`;
      await sql`UPDATE supacloud_worker.admission_limits SET max_per_second=1000,used=0,window_start='-infinity'`;

      // The real worker uses a scoped runtime login, never the fixture installer.
      await psql(renderRoles("fixture"));
      const { worker } = roleNames("fixture");
      await sql.unsafe(`ALTER ROLE ${worker} LOGIN PASSWORD 'fixture-runtime-only';
        GRANT CONNECT ON DATABASE postgres TO ${worker};
        GRANT USAGE ON SCHEMA report_demo TO ${worker};
        GRANT SELECT ON ALL TABLES IN SCHEMA report_demo TO ${worker};
        GRANT INSERT ON report_demo.chunks,report_demo.receipts TO ${worker};
        GRANT UPDATE(state,last_attempt,last_error_code) ON report_demo.requests TO ${worker};
        GRANT SELECT,UPDATE,DELETE ON pgmq.q_scw_reports TO ${worker};
        GRANT SELECT,INSERT ON pgmq.a_scw_reports TO ${worker};
        GRANT SELECT ON pgmq.meta TO ${worker};`);
      const runtimeUrl = new URL(url);
      runtimeUrl.username = worker;
      runtimeUrl.password = "fixture-runtime-only";
      const limited = new SQL(runtimeUrl.toString(), { max: 1 });
      try {
        await expect(Promise.resolve(limited`UPDATE report_demo.sources SET owner_id='intruder'`)).rejects.toThrow();
        await expect(Promise.resolve(limited`UPDATE supacloud_worker.admission_limits SET max_pending=999`)).rejects.toThrow();
      } finally { await limited.close(); }
      runtimeUrl.hostname = "host.docker.internal";
      runtimeUrl.searchParams.set("application_name", "scw_delivery_acceptance");
      const startWorker = async (hold = "") => {
        const name = `scw-delivery-${crypto.randomUUID()}`;
        names.push(name);
        await command(["docker", "run", "-d", "--name", name, "--cpus=0.5", "--memory=256m",
          "--memory-swap=256m", "--pids-limit=64", "--user", `${process.getuid!()}:${process.getgid!()}`,
          "--read-only", "--tmpfs", "/tmp:rw,nosuid,size=32m",
          "--mount", `type=bind,src=${packageDirectory},dst=/app,readonly`,
          "--mount", `type=bind,src=${artifactsDirectory},dst=/artifacts`,
          "-w", "/app",
          "-e", `EDGE_WORKER_DB_URL=${runtimeUrl}`,
          "-e", "SUPACLOUD_PROJECT_REF=fixture", "-e", "SUPABASE_URL=http://host.docker.internal:54321",
          "-e", "SUPABASE_SERVICE_ROLE_KEY=nonprivileged-sql-only",
          "-e", "SUPACLOUD_WORKER_QUEUE=scw_reports", "-e", "SUPACLOUD_WORKER_TASK=report.generate",
          "-e", "SUPACLOUD_WORKER_CONCURRENCY=2", "-e", "SUPACLOUD_WORKER_PG_CONNECTIONS=3",
          "-e", "SUPACLOUD_WORKER_VISIBILITY_SECONDS=15", "-e", "SUPACLOUD_WORKER_RETRY_LIMIT=2",
          "-e", `SCW_TEST_HOLD_AFTER=${hold}`, "-e", "EDGE_WORKER_LOG_LEVEL=error",
          "oven/bun:1.4.2", "bun", "--no-env-file", "tests/fixtures/reporting-worker.ts"]);
        return name;
      };
      const health = (name: string, path: string) => command(["docker", "exec", name, "bun", "-e",
        `const r=await fetch("http://127.0.0.1:19090/${path}"); if(!r.ok)process.exit(1); console.log(await r.text());`]);
      const crashedOperation = crypto.randomUUID();
      await submitReport(sql, "fixture", "operator", crashedOperation, source, "v1");
      const [enqueued] = await sql`SELECT message FROM pgmq.q_scw_reports
        WHERE message->>'idempotencyKey'=${crashedOperation}`;
      expect(enqueued.message.input).toEqual({ operationId: crashedOperation });
      const first = await startWorker(crashedOperation);
      await until(async () => {
        if (await command(["docker", "inspect", "--format={{.State.Running}}", first]) !== "true")
          throw new Error("ACCEPTANCE_WORKER_EXITED");
        return Bun.file(join(artifactsDirectory, "hold")).exists();
      }, 40000);
      await command(["docker", "kill", "--signal=KILL", first]);
      const second = await startWorker();
      await until(async () => {
        const [row] = await sql`SELECT count(*)::int n FROM pgmq.a_scw_reports
          WHERE message->>'idempotencyKey'=${crashedOperation} AND read_ct>=2`;
        return row.n === 1;
      }, 40000);
      expect((await sql`SELECT count(*)::int n FROM report_demo.receipts WHERE operation_id=${crashedOperation}`)[0].n).toBe(1);
      await health(second, "ready");
      const resources = await command(["docker", "exec", second, "cat",
        "/sys/fs/cgroup/cpu.max", "/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory.swap.max",
        "/sys/fs/cgroup/pids.max"]);
      expect(resources).toBe("50000 100000\n268435456\n0\n64");
      const downloaded = await new Response(await downloadReport(sql, new LocalArtifacts(artifactsDirectory),
        "operator", crashedOperation)).text();
      expect(downloaded.split("\n")).toHaveLength(10002);
      expect(downloaded).toContain("9007199254740993");
      await expect(downloadReport(sql, new LocalArtifacts(artifactsDirectory), "intruder", crashedOperation)).rejects.toThrow();

      const apiSql = new SQL(url, { max: 2, connectionTimeout: 2 });
      const api = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        if (request.headers.get("authorization") !== "Bearer fixture-api-only") return new Response(null, { status: 401 });
        const start = performance.now();
        const rows = await apiSql`SELECT id,revision FROM report_demo.sources WHERE id=${source}`;
        return Response.json(rows, { headers: { "x-fixture-database-ms": String(performance.now() - start) } });
      } });
      let timer: ReturnType<typeof setInterval> | undefined;
      let peakAge = 0;
      let peakConnections = 0;
      let observation: Promise<void> | undefined;
      try {
        const apiUrl = `http://127.0.0.1:${api.port}/source`;
        const baseline = await sampleApi(apiUrl, 10);
        const batchStart = Date.now();
        const operations = Array.from({ length: 300 }, () => crypto.randomUUID());
        await Promise.all(operations.map(id => submitReport(sql, "fixture", "operator", id, source, "v1")));
        const observe = () => {
          if (observation) return;
          observation = (async () => {
            const [row] = await sql<{ age: number; connections: number }[]>`
              SELECT COALESCE((SELECT EXTRACT(EPOCH FROM clock_timestamp()-min(enqueued_at)) FROM pgmq.q_scw_reports),0)::float8 age,
                (SELECT count(*)::int FROM pg_stat_activity WHERE application_name='scw_delivery_acceptance') connections`;
            peakAge = Math.max(peakAge, row!.age);
            peakConnections = Math.max(peakConnections, row!.connections);
          })().finally(() => { observation = undefined; });
        };
        timer = setInterval(observe, 100);
        const mixed = await sampleApi(apiUrl, 10);
        await until(async () => {
          const [row] = await sql`SELECT count(*)::int n FROM report_demo.receipts WHERE operation_id<>${crashedOperation}`;
          return row.n === operations.length;
        }, 120000);
        clearInterval(timer);
        await observation;
        const [finish] = await sql<{ ended: number }[]>`
          SELECT (EXTRACT(EPOCH FROM max(completed_at))*1000)::float8 ended
          FROM report_demo.receipts WHERE operation_id<>${crashedOperation}`;
        const evidence = {
          evidence: {
            candidate: process.env.SCW_ACCEPTANCE_CANDIDATE ?? "local-working-tree",
            hardware: "local OrbStack; worker 0.5 CPU / 256 MiB; API pool 2, worker pools 3+2",
            workload: "300 CSV exports x 10000 immutable rows; 50 offered API requests/s",
            rawArtifact: process.env.SCW_ACCEPTANCE_OUTPUT ? basename(process.env.SCW_ACCEPTANCE_OUTPUT) : "test-output-only",
          },
          limits: { minWindowSeconds: 10, minRequests: 450, minRps: 40, maxP95Ms: 250, maxP99Ms: 500,
            maxP99Ratio: 10, maxErrorRate: 0, maxBatchSeconds: 120, maxOldestQueueAgeSeconds: 120 },
          baseline, mixed,
          batch: { startedAtMs: batchStart, expected: operations.length, completed: operations.length,
            seconds: (finish!.ended - batchStart) / 1000, peakOldestQueueAgeSeconds: peakAge },
        };
        const result = evaluateWorkerPerformance(evidence);
        const peakMemoryBytes = Number(await command(["docker", "exec", second, "cat", "/sys/fs/cgroup/memory.peak"]));
        const cpuAccounting = await command(["docker", "exec", second, "cat", "/sys/fs/cgroup/cpu.stat"]);
        report = { evidence, result, resources, peakConnections, peakMemoryBytes, cpuAccounting, recovery: {
          killedAfterCommit: true, repeatDeliveryObserved: true, receiptCount: 1,
        }, admission: { concurrentSubmissions: 12, accepted: 2, rollbackVerified: true, projectLimitVerified: true, rateLimitVerified: true } };
        expect(peakConnections).toBeLessThanOrEqual(5);
        expect(peakMemoryBytes).toBeLessThanOrEqual(268435456);
        expect(result.failures).toEqual([]);
        const metrics = await health(second, "metrics");
        expect(metrics).toContain('scw_stage_seconds_count{stage="read"}');
      } finally {
        if (timer) clearInterval(timer);
        await observation;
        api.stop(true);
        await apiSql.close();
      }
      await command(["docker", "stop", "--time=10", second]);
      expect(await command(["docker", "inspect", "--format={{.State.ExitCode}}", second])).toBe("0");

      // Reuse the real report implementation to prove checkpoint resume after cancellation.
      const resume = crypto.randomUUID();
      await submitReport(sql, "fixture", "operator", resume, source, "v1");
      const controller = new AbortController();
      class InterruptedArtifacts extends LocalArtifacts {
        override async put(content: string) { const digest = await super.put(content); controller.abort(); return digest; }
      }
      const context = { projectRef: "fixture", queueName: "scw_reports", taskKey: "report.generate",
        idempotencyKey: resume, messageId: "1", attempt: 1, signal: controller.signal };
      const interrupted = reportHandler({ sql, telemetry: createWorkerTelemetry(),
        artifacts: new InterruptedArtifacts(artifactsDirectory), batchSize: 128 });
      await expect(interrupted.execute({ operationId: resume }, context)).rejects.toThrow();
      expect((await sql`SELECT count(*)::int n FROM report_demo.chunks WHERE operation_id=${resume}`)[0].n).toBe(1);
      const resumed = reportHandler({ sql, telemetry: createWorkerTelemetry(),
        artifacts: new LocalArtifacts(artifactsDirectory), batchSize: 128 });
      await resumed.execute({ operationId: resume }, { ...context, signal: new AbortController().signal, attempt: 2 });
      expect((await sql`SELECT row_count::int n FROM report_demo.receipts WHERE operation_id=${resume}`)[0].n).toBe(10000);
      const failed = crypto.randomUUID();
      await submitReport(sql, "fixture", "operator", failed, source, "v1");
      class FailedArtifacts extends LocalArtifacts {
        override async put(_content: string): Promise<string> { throw new Error("private-storage-error"); }
      }
      const failing = reportHandler({ sql, telemetry: createWorkerTelemetry(), maxAttempts: 1,
        artifacts: new FailedArtifacts(artifactsDirectory), batchSize: 128 });
      await expect(failing.execute({ operationId: failed }, {
        ...context, idempotencyKey: failed, signal: new AbortController().signal,
      })).rejects.toThrow();
      const [failure] = await sql`SELECT state,last_error_code FROM report_demo.requests WHERE operation_id=${failed}`;
      expect(failure).toEqual({ state: "failed", last_error_code: "REPORT_EXECUTION_FAILED" });
      const emptySource = crypto.randomUUID();
      const empty = crypto.randomUUID();
      await sql`INSERT INTO report_demo.sources VALUES (${emptySource},'v1','operator',true)`;
      await submitReport(sql, "fixture", "operator", empty, emptySource, "v1");
      await resumed.execute({ operationId: empty }, {
        ...context, idempotencyKey: empty, signal: new AbortController().signal,
      });
      expect(await new Response(await downloadReport(sql, new LocalArtifacts(artifactsDirectory),
        "operator", empty)).text()).toBe("row_id,label,amount_cents\n");
    });
    accepted = true;
    console.log("SCW_LOCAL_ACCEPTANCE_PASSED");
  } catch (error) {
    for (const name of names) {
      const logs = await command(["docker", "logs", "--tail=60", name]).catch(() => "worker diagnostics unavailable");
      console.error(logs.replaceAll(/postgres(?:ql)?:\/\/\S+/g, "[REDACTED_DATABASE_URL]"));
    }
    throw error;
  } finally {
    for (const name of names) await command(["docker", "rm", "--force", name]).catch(() => {});
    await rm(artifactsDirectory, { recursive: true, force: true });
    if (process.env.SCW_ACCEPTANCE_OUTPUT && report) {
      const path = accepted ? process.env.SCW_ACCEPTANCE_OUTPUT
        : `${process.env.SCW_ACCEPTANCE_OUTPUT}.failed-${Date.now()}.json`;
      await Bun.write(path, JSON.stringify({ accepted, report }, null, 2) + "\n");
    }
  }
}

export async function nativeProtocolAcceptance() {
  const directory = await mkdtemp(join(tmpdir(), "scw-native-"));
  const binary = join(directory, "accounting-worker");
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const address = `127.0.0.1:${reservation.port}`;
  reservation.stop(true);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await command(["go", "-C", resolve(import.meta.dir, "../../examples/go-accounting"), "build", "-o", binary, "."]);
    child = Bun.spawn([binary], { env: {
      PATH: process.env.PATH, SUPACLOUD_PROJECT_REF: "fixture",
      SCW_NATIVE_TOKEN: "x".repeat(32), SCW_NATIVE_CONCURRENCY: "2", SCW_NATIVE_ADDRESS: address,
    }, stdout: "ignore", stderr: "ignore" });
    await until(async () => {
      try { return (await fetch(`http://${address}/ready`)).ok; } catch { return false; }
    }, 10000);
    const response = await normalizeAccounting(`http://${address}`, "x".repeat(32), {
      schemaVersion: 1, projectRef: "fixture", operationId: "recording:1",
      records: [{
        sessionId: "session-1", sequence: "1", kind: "interim",
        inputOctets: "18446744073709551615", outputOctets: "9007199254740993",
        recordedAt: "2026-10-04T08:00:00+08:00",
      }],
    }, { signal: new AbortController().signal, timeoutMs: 1000 });
    expect(response.records[0]?.inputOctets).toBe("18446744073709551615");
    expect(response.records[0]?.recordedAt).toBe("2026-10-04T00:00:00Z");
    child.kill("SIGTERM");
    const exit = await Promise.race([child.exited, Bun.sleep(12000).then(() => -1)]);
    expect(exit).toBe(0);
  } finally {
    if (child?.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    await rm(directory, { recursive: true, force: true });
  }
}
