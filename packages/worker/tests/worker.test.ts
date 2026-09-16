import { describe, expect, test } from "bun:test";
import type { EdgeWorker, Json } from "@pgflow/edge-worker";
import { Flow } from "@pgflow/dsl";
import { createPgflowQueueWorker, createPgflowWorker } from "../src/index.js";
import { createQueueHandler, type TaskContext } from "../src/queue-handler.js";
import { createLifecycle } from "../src/lifecycle.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMigrations, renderInstall } from "../scripts/migrations.js";
import { until, withPgflowDatabase } from "./fixtures/database.js";
import { sharedDatabaseAcceptance } from "./fixtures/shared-database.js";
import { renderSchedule, roleNames } from "../scripts/scheduler.js";

const binding = {
  projectRef: "project-a",
  queueName: "scw_reports",
  taskKey: "report.render",
};
const options = {
  ...binding,
  connectionString: "postgresql://worker:secret@localhost/project_a",
};
const payload = {
  schemaVersion: 1,
  projectRef: "project-a",
  taskKey: "report.render",
  idempotencyKey: "report:42:revision:3",
  input: { reportId: "42" },
};
function decode(value: unknown) {
  if (
    value === null ||
    typeof value !== "object" ||
    !("reportId" in value) ||
    typeof value.reportId !== "string"
  ) {
    throw new Error("private decoder data");
  }
  return { reportId: value.reportId };
}
type Context = Parameters<Parameters<typeof EdgeWorker.startQueueWorker>[0]>[1];
function context(signal = new AbortController().signal): Context {
  return {
    env: { PRIVATE_TOKEN: "must-not-leak" },
    shutdownSignal: signal,
    workerConfig: {
      connectionString: "postgresql://private:password@db/project",
      maxConcurrent: 4,
      maxPollSeconds: 2,
      pollIntervalMs: 200,
      batchSize: 4,
      visibilityTimeout: 300,
    },
    rawMessage: {
      msg_id: 42,
      read_ct: 1,
      enqueued_at: "2026-09-16T00:00:00Z",
      vt: "2026-09-16T00:05:00Z",
      message: payload,
    },
  };
}

describe("pgflow process adapter", () => {
  test("central scheduler validates target and scopes peer socket configuration", () => {
    const sql = renderSchedule("project-a", "tenant_a", "/var/run/postgresql");
    expect(sql).toContain("SET LOCAL ROLE " + roleNames("project-a").recovery);
    expect(sql).toContain("SET nodename='/var/run/postgresql'");
    expect(sql).toContain("PGFLOW_SCHEDULER_BINDING_CONFLICT");
    expect(() => renderSchedule("project-a", "tenant_a", "/tmp';--")).toThrow();
    expect(() => renderSchedule("project-a", "tenant';--")).toThrow();
    expect(() => roleNames("project';--")).toThrow();
  });
  test.skipIf(process.env.PGFLOW_SHARED_ACCEPTANCE !== "1")(
    "PostgreSQL 18 shared scheduler and least-privilege crash recovery",
    sharedDatabaseAcceptance, 230_000,
  );
  test("installer is version locked, target bound and checksum protected", async () => {
    const migrations = await loadMigrations();
    expect(migrations).toHaveLength(24);
    const script = renderInstall(migrations, "fixture", "postgres");
    expect(script).toContain("pg_advisory_xact_lock");
    expect(script).toContain("PGFLOW_MIGRATION_CHECKSUM_MISMATCH");
    expect(script).toContain("PGFLOW_UNTRACKED_BASELINE");
    expect(script).toContain("PGFLOW_INSTALLATION_BINDING_MISMATCH");
    expect(() =>
      renderInstall(migrations, "fixture';--", "postgres"),
    ).toThrow();
    expect(() =>
      renderInstall(migrations, "fixture", "postgres';--"),
    ).toThrow();
    expect(() =>
      renderInstall([migrations[0]!, migrations[0]!], "fixture", "postgres"),
    ).toThrow();
  });

  test.skipIf(process.env.PGFLOW_DATABASE_ACCEPTANCE !== "1")(
    "real database installation, task API and kill/restart recovery",
    async () => {
      await withPgflowDatabase(async (db, url, install) => {
        await Promise.all([install(), install()]);
        const [receipt] =
          await db`SELECT count(*)::int AS count FROM supacloud_worker.migrations`;
        expect(receipt.count).toBe(24);
        await expect(install("wrong-project")).rejects.toThrow(
          "PGFLOW_INSTALLATION_BINDING_MISMATCH",
        );
        const [checksum] =
          await db`SELECT version,sha256 FROM supacloud_worker.migrations ORDER BY version LIMIT 1`;
        await db`UPDATE supacloud_worker.migrations SET sha256='tampered' WHERE version=${checksum.version}`;
        await expect(install()).rejects.toThrow(
          "PGFLOW_MIGRATION_CHECKSUM_MISMATCH",
        );
        await db`UPDATE supacloud_worker.migrations SET sha256=${checksum.sha256} WHERE version=${checksum.version}`;
        const [cron] = await db`SELECT count(*)::int AS count FROM cron.job
          WHERE jobname='pgflow_requeue_stalled_tasks' AND active`;
        expect(cron.count).toBe(1);
        const [http] =
          await db`SELECT count(*)::int AS count FROM cron.job WHERE jobname='pgflow_ensure_workers'`;
        expect(http.count).toBe(0);
        const [access] =
          await db`SELECT has_schema_privilege('anon','pgflow','USAGE') AS allowed`;
        expect(access.allowed).toBe(false);

        const workers: ReturnType<typeof Bun.spawn>[] = [];
        const logs: Promise<string>[] = [];
        function spawnWorker(phase?: string) {
          const child = Bun.spawn(
            [
              "bun",
              new URL("./fixtures/crash-worker.ts", import.meta.url).pathname,
            ],
            {
              env: {
                ...process.env,
                WORKER_TEST_DATABASE_URL: url,
                SUPACLOUD_PROJECT_REF: "fixture",
                SUPABASE_URL: "http://localhost:54321",
                SUPABASE_SERVICE_ROLE_KEY: "fixture-local-only",
                WORKER_NAME: "scw_crash_v1",
                EDGE_WORKER_LOG_LEVEL: "info",
                ...(phase === undefined
                  ? {}
                  : { WORKER_TEST_CRASH_PHASE: phase }),
              },
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          workers.push(child);
          logs.push(
            Promise.all([
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
            ]).then((parts) => parts.join("\n")),
          );
          return child;
        }
        let completedId = "";
        try {
          const warmup = spawnWorker();
          await until(
            async () =>
              (
                await db`SELECT 1 FROM pgflow.flows WHERE flow_slug='scw_crash_v1'`
              ).length > 0,
          );
          const warmupInput = { operationId: crypto.randomUUID() };
          const [warmupRun] =
            await db`SELECT run_id FROM pgflow.start_flow('scw_crash_v1', ${warmupInput}::jsonb)`;
          await until(async () => {
            const [state] =
              await db`SELECT status FROM supacloud_worker.tasks WHERE id=${`pgflow:${warmupRun.run_id}`}`;
            return state?.status === "succeeded";
          });
          const routeFixture = new URL(
            "../../management-api/tests/helpers/pgflow-route-acceptance.ts",
            import.meta.url,
          ).pathname;
          const route = Bun.spawnSync(["bun", routeFixture], {
            env: {
              ...process.env,
              WORKER_TEST_DATABASE_URL: url,
              WORKER_TEST_RUN_ID: warmupRun.run_id,
            },
          });
          expect(new TextDecoder().decode(route.stderr)).toBe("");
          expect(route.exitCode).toBe(0);
          const failedInput = { operationId: crypto.randomUUID(), fail: true };
          const [failedRun] =
            await db`SELECT run_id FROM pgflow.start_flow('scw_crash_v1', ${failedInput}::jsonb)`;
          const observed = new Set<string>();
          await until(async () => {
            const [state] =
              await db`SELECT status,error FROM supacloud_worker.tasks WHERE id=${`pgflow:${failedRun.run_id}`}`;
            if (state) observed.add(state.status);
            if (state?.status !== "failed") return false;
            expect(state.error).toBe("PGFLOW_RUN_FAILED");
            return true;
          });
          expect(observed.has("retry_scheduled")).toBe(true);
          warmup.kill("SIGTERM");
          await warmup.exited;
          for (const phase of ["before", "after"]) {
            const worker = spawnWorker(phase);
            await until(async () => {
              const rows =
                await db`SELECT 1 FROM pgflow.flows WHERE flow_slug='scw_crash_v1'`;
              return rows.length > 0;
            });
            const operation = crypto.randomUUID();
            const input = { operationId: operation };
            const [run] =
              await db`SELECT run_id FROM pgflow.start_flow('scw_crash_v1', ${input}::jsonb)`;
            completedId = run.run_id;
            await until(async () => {
              const rows =
                phase === "after"
                  ? await db`SELECT 1 FROM test_effects WHERE operation_id=${operation}::uuid`
                  : await db`SELECT 1 FROM test_attempts WHERE operation_id=${operation}::uuid`;
              return rows.length > 0;
            });
            worker.kill("SIGKILL");
            await worker.exited;
            const [started] =
              await db`SELECT status FROM supacloud_worker.tasks WHERE id=${`pgflow:${completedId}`}`;
            expect(started.status).toBe("running");
            const recovery = spawnWorker();
            // Real wall time and the actual scheduled reaper, no timestamp/lease rewrites.
            await until(async () => {
              const [state] =
                await db`SELECT status FROM supacloud_worker.tasks WHERE id=${`pgflow:${completedId}`}`;
              return state?.status === "succeeded";
            }, 100_000);
            const [effects] =
              await db`SELECT count(*)::int AS count FROM test_effects WHERE operation_id=${operation}::uuid`;
            const [attempts] =
              await db`SELECT count(*)::int AS count FROM test_attempts WHERE operation_id=${operation}::uuid`;
            expect(effects.count).toBe(1);
            expect(attempts.count).toBeGreaterThanOrEqual(2);
            recovery.kill("SIGTERM");
            await recovery.exited;
          }
          const [events] =
            await db`SELECT count(*)::int AS count FROM realtime.messages`;
          expect(events.count).toBeGreaterThan(0);
          const [recoveryJobs] =
            await db`SELECT count(*)::int AS count FROM cron.job_run_details d
            JOIN cron.job j USING(jobid) WHERE j.jobname='pgflow_requeue_stalled_tasks' AND d.status='succeeded'`;
          expect(recoveryJobs.count).toBeGreaterThan(0);
        } catch (error) {
          console.error(
            "Engine tasks",
            await db`SELECT * FROM pgflow.step_tasks`,
          );
          console.error("Workers", await db`SELECT * FROM pgflow.workers`);
          console.error("Queue", await db`SELECT * FROM pgmq.q_scw_crash_v1`);
          for (const child of workers)
            if (child.exitCode === null) child.kill("SIGKILL");
          await Promise.all(workers.map((child) => child.exited));
          console.error((await Promise.all(logs)).join("\n"));
          throw error;
        } finally {
          for (const child of workers)
            if (child.exitCode === null) child.kill("SIGKILL");
          await Promise.all(workers.map((child) => child.exited));
        }
      });
    },
    260_000,
  );
  test("authorized handler receives only captured project/task context, not runtime secrets", async () => {
    const seen: TaskContext[] = [];
    const mutable = { ...binding };
    const handler = createQueueHandler(mutable, {
      decode,
      authorize: () => true,
      execute(input, ctx) {
        expect(input.reportId).toBe("42");
        seen.push(ctx);
      },
    });
    mutable.projectRef = "project-b";
    await handler(payload, context());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.projectRef).toBe("project-a");
    expect(seen[0]?.messageId).toBe("42");
    expect(seen[0]?.idempotencyKey).toBe(payload.idempotencyKey);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(JSON.stringify(seen)).not.toContain("password");
    expect(seen[0]).not.toHaveProperty("env");
    expect(seen[0]).not.toHaveProperty("sql");
  });

  test("project, task, schema and payload failures never invoke business code", async () => {
    let calls = 0;
    const handler = createQueueHandler(binding, {
      decode,
      authorize: () => true,
      execute() {
        calls++;
      },
    });
    const invalid: Json[] = [
      null,
      [],
      { ...payload, projectRef: "other" },
      { ...payload, taskKey: "other" },
      { ...payload, schemaVersion: 2 },
      { ...payload, idempotencyKey: "" },
      { ...payload, input: {} },
      { ...payload, serviceRole: "secret" },
    ];
    for (const value of invalid)
      await expect(handler(value, context())).rejects.toThrow(
        "WORKER_TASK_INVALID",
      );
    expect(calls).toBe(0);
  });

  test("authorization is mandatory and raw failures are not sent to the upstream retry ledger", async () => {
    let calls = 0;
    const denied = createQueueHandler(binding, {
      decode,
      authorize: () => false,
      execute() {
        calls++;
      },
    });
    await expect(denied(payload, context())).rejects.toThrow(
      "WORKER_TASK_FORBIDDEN",
    );
    const failed = createQueueHandler(binding, {
      decode,
      authorize: () => true,
      execute() {
        throw new Error("password=private");
      },
    });
    await expect(failed(payload, context())).rejects.toThrow(
      "WORKER_TASK_FAILED",
    );
    const policyFailed = createQueueHandler(binding, {
      decode,
      authorize() {
        throw new Error("credential");
      },
      execute() {
        calls++;
      },
    });
    await expect(policyFailed(payload, context())).rejects.toThrow(
      "WORKER_TASK_FAILED",
    );
    expect(calls).toBe(0);
  });

  test("message identities cannot silently lose precision", async () => {
    const seen: string[] = [];
    const handler = createQueueHandler(binding, {
      decode,
      authorize: () => true,
      execute(_input, ctx) {
        seen.push(ctx.messageId);
      },
    });
    const ctx = context();
    ctx.rawMessage.msg_id = Number.MAX_SAFE_INTEGER + 1;
    await expect(handler(payload, ctx)).rejects.toThrow("WORKER_TASK_INVALID");
    ctx.rawMessage.msg_id = Number.MAX_SAFE_INTEGER;
    await handler(payload, ctx);
    for (const id of ["42", "9007199254740993", "9223372036854775807"]) {
      Reflect.set(ctx.rawMessage, "msg_id", id);
      await handler(payload, ctx);
      expect(seen.at(-1)).toBe(id);
      const rawIdentity: unknown = Reflect.get(ctx.rawMessage, "msg_id");
      expect(rawIdentity).toBe(id);
    }
    for (const id of [
      "0",
      "01",
      "-1",
      "1.2",
      "1e3",
      "9223372036854775808",
      null,
      1n,
    ]) {
      Reflect.set(ctx.rawMessage, "msg_id", id);
      await expect(handler(payload, ctx)).rejects.toThrow(
        "WORKER_TASK_INVALID",
      );
    }
  });

  test("shutdown prevents new side effects and is rechecked after async authorization", async () => {
    const abort = new AbortController();
    let calls = 0;
    const handler = createQueueHandler(binding, {
      decode,
      authorize() {
        abort.abort();
        return true;
      },
      execute() {
        calls++;
      },
    });
    await expect(handler(payload, context(abort.signal))).rejects.toThrow(
      "WORKER_SHUTTING_DOWN",
    );
    expect(calls).toBe(0);
    await expect(handler(payload, context(abort.signal))).rejects.toThrow(
      "WORKER_SHUTTING_DOWN",
    );
    await expect(handler(payload, context(abort.signal))).rejects.toMatchObject(
      { name: "AbortError" },
    );
  });

  test("queue namespaces and resource limits are checked without opening connections", () => {
    const handler = { decode, authorize: () => true, execute() {} };
    for (const queueName of [
      "tasks",
      "supacloud_internal_workflows",
      "approval",
      "scw_",
      "scw_A",
    ]) {
      expect(() =>
        createPgflowQueueWorker({ ...options, queueName }, handler),
      ).toThrow("WORKER_QUEUE_INVALID");
    }
    for (const concurrency of [0, 33, 1.1, NaN]) {
      expect(() =>
        createPgflowQueueWorker({ ...options, concurrency }, handler),
      ).toThrow("WORKER_CONFIG_INVALID");
    }
    expect(() =>
      createPgflowQueueWorker(
        { ...options, connectionString: "https://secret.invalid" },
        handler,
      ),
    ).toThrow("WORKER_CONNECTION_INVALID");
    expect(createPgflowQueueWorker(options, handler).state).toBe("idle");
    const flow = new Flow<{ reportId: string }>({ slug: "scw_report_v1" }).step(
      { slug: "prepare" },
      (input) => ({ reportId: input.reportId }),
    );
    expect(createPgflowWorker(flow, options).state).toBe("idle");
  });

  test("aborted I/O preserves upstream abort semantics during policy and execution", async () => {
    for (const phase of ["authorize", "execute"]) {
      const abort = new AbortController();
      const interrupt = () => {
        abort.abort();
        throw new Error("private I/O details");
      };
      const handler = createQueueHandler(binding, {
        decode,
        authorize: phase === "authorize" ? interrupt : () => true,
        execute: interrupt,
      });
      await expect(
        handler(payload, context(abort.signal)),
      ).rejects.toMatchObject({
        name: "AbortError",
        message: "WORKER_SHUTTING_DOWN",
      });
    }
  });

  test("lifecycle shares concurrent startup, drains on stop and forbids restart", async () => {
    let starts = 0;
    let stops = 0;
    let unblock: () => void = () => {
      throw new Error("not assigned");
    };
    const ready = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const worker = createLifecycle(async () => {
      starts++;
      await ready;
      return {
        async stopWorker() {
          stops++;
        },
      };
    });
    const first = worker.start();
    const second = worker.start();
    const stop = worker.stop();
    expect(worker.state).toBe("stopping");
    unblock();
    await Promise.all([first, second, stop, worker.stop()]);
    expect(starts).toBe(1);
    expect(stops).toBe(1);
    expect(worker.state).toBe("stopped");
    await expect(worker.start()).rejects.toThrow(
      "WORKER_RESTART_REQUIRES_NEW_PROCESS",
    );
  });

  test("failed startup and shutdown expose bounded error codes", async () => {
    const failed = createLifecycle(async () => {
      throw new Error("secret");
    });
    await expect(failed.start()).rejects.toThrow("WORKER_START_FAILED");
    expect(failed.state).toBe("failed");
    const worker = createLifecycle(async () => ({
      async stopWorker() {
        throw new Error("password");
      },
    }));
    await worker.start();
    await expect(worker.stop()).rejects.toThrow("WORKER_STOP_FAILED");
    expect(worker.state).toBe("failed");
  });

  test("stopping before startup is terminal and never opens a worker", async () => {
    let starts = 0;
    const worker = createLifecycle(async () => {
      starts++;
      return { async stopWorker() {} };
    });
    await worker.stop();
    await worker.stop();
    await expect(worker.start()).rejects.toThrow(
      "WORKER_RESTART_REQUIRES_NEW_PROCESS",
    );
    expect(starts).toBe(0);
    expect(worker.state).toBe("stopped");
  });

  test("queue and flow startup delegate once in isolated processes", () => {
    const fixture = new URL("./fixtures/delegate.ts", import.meta.url).pathname;
    for (const mode of ["queue", "flow", "wrong-project", "edge-runtime"]) {
      const result = Bun.spawnSync(["bun", fixture, mode], {
        env: {
          ...process.env,
          SUPACLOUD_PROJECT_REF: "project-a",
          SUPABASE_URL: "http://localhost:54321",
          SUPABASE_SERVICE_ROLE_KEY: "local-test-placeholder",
        },
      });
      expect(
        new TextDecoder().decode(result.stdout) +
          new TextDecoder().decode(result.stderr),
      ).toBe("");
      expect(result.exitCode).toBe(0);
    }
  });

  test("strict public types and distributable artifacts build against the pinned upstream package", async () => {
    const tsc = new URL("../node_modules/typescript/bin/tsc", import.meta.url)
      .pathname;
    const cwd = new URL("../", import.meta.url).pathname;
    const directory = await mkdtemp(join(tmpdir(), "supacloud-worker-"));
    try {
      for (const args of [
        ["-p", "tsconfig.test.json"],
        ["-p", "tsconfig.json", "--outDir", directory],
      ]) {
        const result = Bun.spawnSync(["bun", tsc, ...args], { cwd });
        expect(
          new TextDecoder().decode(result.stdout) +
            new TextDecoder().decode(result.stderr),
        ).toBe("");
        expect(result.exitCode).toBe(0);
      }
      expect(await Bun.file(join(directory, "index.js")).exists()).toBe(true);
      expect(await Bun.file(join(directory, "index.d.ts")).exists()).toBe(true);
      const upstream = await import("@pgflow/edge-worker");
      expect(typeof upstream.EdgeWorker.startQueueWorker).toBe("function");
      expect(typeof upstream.EdgeWorker.startFlowWorker).toBe("function");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
