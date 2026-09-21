import { expect, test } from "bun:test";
import { SQL } from "bun";
import { withNativePostgres, waitForPostgresFixture } from "../helpers/native-postgres";
import { readPgflowState, registerPgflowWorker, setPgflowEnabled } from "../../src/services/pgflow.service";
import { PGFLOW_MIGRATIONS } from "../../src/db/pgflow-bundle";

test("bundled pgflow installs without hosted services and pauses without deleting runs", async () => {
    const bundle = PGFLOW_MIGRATIONS.map((migration) => migration.sql).join("\n");
    expect(bundle).not.toContain(".supabase.co");
    expect(bundle).not.toContain("cron.schedule(");
    expect(bundle).not.toContain("vault.decrypted_secrets");
    await withNativePostgres(async (db) => {
        await db`CREATE ROLE service_role NOLOGIN`;
        expect((await setPgflowEnabled(db, true)).enabled).toBe(true);
        expect((await setPgflowEnabled(db, true)).enabled).toBe(true);
        await db`SELECT pgflow.create_flow('fixture')`;
        await db`SELECT pgflow.add_step('fixture', 'first')`;
        const [run] = await db`SELECT * FROM pgflow.start_flow('fixture', '{"hello":"world"}'::jsonb)`;
        expect(run.run_id).toBeDefined();
        const workerId = crypto.randomUUID();
        await db`INSERT INTO pgflow.workers(worker_id, queue_name, function_name) VALUES (${workerId}, 'fixture', 'fixture-worker')`;
        await registerPgflowWorker(db, "fixture-worker", true);
        const claimed = await db`SELECT * FROM pgflow.start_tasks('fixture',
            ARRAY(SELECT message_id FROM pgflow.step_tasks WHERE run_id = ${run.run_id}), ${workerId}::uuid)`;
        expect(claimed.length).toBe(1);
        expect((await setPgflowEnabled(db, false)).enabled).toBe(false);
        expect((await readPgflowState(db)).installed).toBe(true);
        expect((await db`SELECT * FROM pgflow.runs`).length).toBe(1);
        await expect((async () => { await db`SELECT * FROM pgflow.start_flow('fixture', '{}'::jsonb)`; })()).rejects.toThrow("paused");
        expect((await db`SELECT * FROM pgflow.start_tasks('fixture', ARRAY[]::bigint[], gen_random_uuid())`).length).toBe(0);
        await db`SELECT * FROM pgflow.complete_task(${run.run_id}::uuid, 'first', 0, '{"done":true}'::jsonb)`;
        const [completed] = await db`SELECT status FROM pgflow.runs WHERE run_id = ${run.run_id}`;
        expect(completed.status).toBe("completed");
        const [permissions] = await db`
            SELECT has_function_privilege('service_role', 'pgflow._supacloud_start_flow(text,jsonb,uuid)', 'EXECUTE') AS bypass,
                has_table_privilege('service_role', 'pgflow._supacloud_state', 'UPDATE') AS change_state
        `;
        expect(permissions.bypass).toBe(false);
        expect(permissions.change_state).toBe(false);
        expect((await setPgflowEnabled(db, true)).enabled).toBe(true);
        await db`SELECT * FROM pgflow.start_flow('fixture', '{}'::jsonb)`;
        expect((await db`SELECT * FROM pgflow.runs`).length).toBe(2);
        expect((await db`SELECT * FROM pgflow._supacloud_events`).length).toBeGreaterThan(0);
    }, { image: "ghcr.io/pgmq/pg18-pgmq:v1.10.0" });
}, 120_000);

test("unmanaged schemas are not adopted or deleted", async () => {
    await withNativePostgres(async (db) => {
        await db`CREATE SCHEMA pgflow`;
        await expect(setPgflowEnabled(db, true)).rejects.toThrow("unmanaged");
        await expect(setPgflowEnabled(db, false)).rejects.toThrow("unmanaged");
        expect((await readPgflowState(db)).installed).toBe(true);
    }, { image: "ghcr.io/pgmq/pg18-pgmq:v1.10.0" });
}, 120_000);

test("official process worker runs without management/cloud and recovers after a crash", async () => {
    await withNativePostgres(async (db, url) => {
        await db`CREATE ROLE service_role NOLOGIN`;
        await setPgflowEnabled(db, true);
        await db`CREATE ROLE project_worker LOGIN PASSWORD 'synthetic-worker' NOSUPERUSER NOCREATEDB NOCREATEROLE`;
        const compiled = Bun.spawn([
            process.execPath, "--eval",
            `import { compileFlow } from ${JSON.stringify(`${import.meta.dir}/../../../pgflow-worker/src/compile.ts`)}; await compileFlow();`,
        ], {
            env: {
                PATH: process.env.PATH, DATABASE_URL: url, PGFLOW_WORKER_ROLE: "project_worker",
                PGFLOW_FLOW_MODULE: `${import.meta.dir}/../../../pgflow-worker/examples/flow.ts`,
            },
            stdout: "pipe", stderr: "pipe",
        });
        const [compileErrors, compileCode] = await Promise.all([new Response(compiled.stderr).text(), compiled.exited]);
        if (compileCode !== 0) throw new Error(compileErrors);
        const workerUrl = new URL(url);
        workerUrl.username = "project_worker";
        workerUrl.password = "synthetic-worker";
        const runtimeDb = new SQL(workerUrl.href, { max: 1 });
        try {
            await expect((async () => { await runtimeDb`UPDATE pgflow._supacloud_state SET enabled = false`; })()).rejects.toThrow("permission denied");
            await expect((async () => { await runtimeDb`SELECT pgflow._supacloud_start_flow('self_hosted_example', '{}', NULL)`; })()).rejects.toThrow("permission denied");
            await db`CREATE DATABASE other_project`;
            const otherUrl = new URL(url);
            otherUrl.pathname = "/other_project";
            const otherAdmin = new SQL(otherUrl.href, { max: 2 });
            try { await setPgflowEnabled(otherAdmin, true); } finally { await otherAdmin.close(); }
            otherUrl.username = workerUrl.username;
            otherUrl.password = workerUrl.password;
            const otherRuntime = new SQL(otherUrl.href, { max: 1 });
            try {
                await expect((async () => { await otherRuntime`SELECT * FROM pgflow.runs`; })()).rejects.toThrow("permission denied");
                await expect((async () => { await otherRuntime`SELECT * FROM pgflow.start_flow('fixture', '{}')`; })()).rejects.toThrow("permission denied");
            } finally { await otherRuntime.close(); }
        } finally { await runtimeDb.close(); }
        const start = () => Bun.spawn([
            process.execPath, "--eval",
            `import { runPgflowWorker } from ${JSON.stringify(`${import.meta.dir}/../../../pgflow-worker/src/index.ts`)}; await runPgflowWorker();`,
        ], {
            env: {
                PATH: process.env.PATH,
                DATABASE_URL: workerUrl.href,
                SUPABASE_URL: "http://127.0.0.1:9",
                SUPABASE_SERVICE_ROLE_KEY: "synthetic-not-a-real-key",
                WORKER_NAME: "process-fixture",
                PGFLOW_FLOW_MODULE: `${import.meta.dir}/../../../pgflow-worker/examples/flow.ts`,
            },
            stdout: "pipe", stderr: "pipe",
        });
        let child = start();
        let logs = new Response(child.stdout).text();
        let errors = new Response(child.stderr).text();
        try {
            await waitForPostgresFixture(async () => {
                if (child.exitCode !== null) throw new Error(`Worker failed: ${await errors} ${await logs}`);
                return (await db`SELECT * FROM pgflow.workers`).length > 0;
            });
            const [run] = await db`SELECT * FROM pgflow.start_flow('self_hosted_example', '{"value":7,"delayMs":3000}'::jsonb)`;
            await waitForPostgresFixture(async () => {
                const [task] = await db`SELECT status FROM pgflow.step_tasks WHERE run_id = ${run.run_id}`;
                return task.status === "started";
            });
            child.kill("SIGKILL");
            await child.exited;
            await Promise.all([logs, errors]);
            // Make the crashed task's lease expire without a wall-clock wait.
            await db`UPDATE pgflow.step_tasks SET queued_at = now() - interval '2 minutes',
                started_at = now() - interval '1 minute' WHERE run_id = ${run.run_id}`;
            await db`UPDATE pgmq.q_self_hosted_example SET vt = now() - interval '1 minute'`;
            child = start();
            logs = new Response(child.stdout).text();
            errors = new Response(child.stderr).text();
            await waitForPostgresFixture(async () => {
                if (child.exitCode !== null) throw new Error(`Worker failed: ${await errors} ${await logs}`);
                const [row] = await db`SELECT status FROM pgflow.runs WHERE run_id = ${run.run_id}`;
                return row.status === "completed";
            });
            const [task] = await db`SELECT attempts_count FROM pgflow.step_tasks WHERE run_id = ${run.run_id}`;
            expect(task.attempts_count).toBe(2);
            expect((await readPgflowState(db)).runtime_status).toBe("running");
            await db`UPDATE pgflow.steps SET opt_start_delay = 60 WHERE flow_slug = 'self_hosted_example'`;
            const [pending] = await db`SELECT * FROM pgflow.start_flow('self_hosted_example', '{"value":8}'::jsonb)`;
            await setPgflowEnabled(db, false);
            await db`UPDATE pgmq.q_self_hosted_example SET vt = now() - interval '1 minute'`;
            await Bun.sleep(1500);
            const [unclaimed] = await db`SELECT attempts_count FROM pgflow.step_tasks WHERE run_id = ${pending.run_id}`;
            expect(unclaimed.attempts_count).toBe(0);
            expect((await readPgflowState(db)).runtime_status).toBe("paused");
            expect((await db`SELECT * FROM pgflow.runs`).length).toBe(2);
            await setPgflowEnabled(db, true);
            await db`UPDATE pgflow.steps SET opt_start_delay = 0 WHERE flow_slug = 'self_hosted_example'`;
            await db`UPDATE pgmq.q_self_hosted_example SET vt = now() - interval '1 minute'`;
            const [next] = await db`SELECT * FROM pgflow.start_flow('self_hosted_example', '{"value":9}'::jsonb)`;
            await waitForPostgresFixture(async () => {
                const [row] = await db`SELECT status FROM pgflow.runs WHERE run_id = ${next.run_id}`;
                return row.status === "completed";
            });
        } finally {
            child.kill("SIGTERM");
            const result = await Promise.race([child.exited, Bun.sleep(10_000).then(() => null)]);
            if (result === null) child.kill("SIGKILL");
            await child.exited;
            await Promise.all([logs, errors]);
        }
    }, { image: "ghcr.io/pgmq/pg18-pgmq:v1.10.0" });
}, 120_000);
