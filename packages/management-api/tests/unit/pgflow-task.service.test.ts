// @supacloud-test-isolate
import { expect, mock, test } from "bun:test";
import { withNativePostgres } from "../helpers/native-postgres";

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
    "pgflow task submission, recovery and terminal state use one identity",
    async () => withNativePostgres(async (database) => {
        const original = await import("../../src/db");
        mock.module("../../src/db", () => ({ ...original, sql: database, getProjectDb: () => database }));
        mock.module("../../src/services/auth-runtime.service", () => ({
            getAuthRuntimeDescriptor: () => ({ authority_project_ref: "authority" }),
        }));
        let enabled = true;
        mock.module("../../src/repositories/project.repository", () => ({
            projectRepository: {
                findByRef: async (ref: string) => ref === "missing" ? null : {
                    ref, db_name: "fixture", config: { pgflow_enabled: enabled },
                },
            },
        }));
        const service = await import("../../src/services/pgflow-task.service");
        // Database adapter contract fixture, not a substitute for pgflow's engine tests.
        await database.unsafe(`
            CREATE TABLE project_tasks (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_ref text NOT NULL,
                task_type text NOT NULL, status text DEFAULT 'pending', payload jsonb DEFAULT '{}',
                result jsonb, error text, retries integer DEFAULT 0, attempt integer DEFAULT 0,
                max_attempts integer DEFAULT 3, next_run_at timestamptz DEFAULT NOW(),
                lease_until timestamptz, started_at timestamptz, completed_at timestamptz,
                timeout_sec integer, idempotency_key text, trace_id text, cancel_requested_at timestamptz,
                cancellation_reason text, correlation_id text, business_task_id text, invoker_user_id uuid,
                auth_authority_ref text, metadata jsonb DEFAULT '{}', function_slug text, function_version text,
                created_at timestamptz DEFAULT NOW(), updated_at timestamptz DEFAULT NOW()
            );
            CREATE UNIQUE INDEX task_idempotency ON project_tasks(project_ref, idempotency_key)
                WHERE idempotency_key IS NOT NULL;
            CREATE SCHEMA pgflow;
            CREATE TABLE pgflow.flows (flow_slug text PRIMARY KEY);
            INSERT INTO pgflow.flows VALUES ('single'), ('parallel');
            CREATE TABLE pgflow.runs (
                run_id uuid PRIMARY KEY, flow_slug text REFERENCES pgflow.flows,
                input jsonb NOT NULL, status text DEFAULT 'started', output jsonb,
                started_at timestamptz DEFAULT NOW(), completed_at timestamptz, failed_at timestamptz
            );
            CREATE TABLE pgflow._supacloud_state (
                singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
                version text NOT NULL,
                enabled boolean NOT NULL DEFAULT true
            );
            INSERT INTO pgflow._supacloud_state(version) VALUES ('0.16.0');
            CREATE TABLE pgflow.step_states (
                run_id uuid NOT NULL, step_slug text NOT NULL,
                status text NOT NULL DEFAULT 'created',
                created_at timestamptz DEFAULT NOW(), started_at timestamptz,
                completed_at timestamptz, failed_at timestamptz,
                PRIMARY KEY (run_id, step_slug)
            );
            CREATE TABLE pgflow.step_tasks (
                run_id uuid NOT NULL, step_slug text NOT NULL,
                status text NOT NULL DEFAULT 'queued', attempts_count integer NOT NULL DEFAULT 0,
                queued_at timestamptz DEFAULT NOW(), started_at timestamptz,
                completed_at timestamptz, failed_at timestamptz,
                PRIMARY KEY (run_id, step_slug)
            );
            CREATE FUNCTION pgflow.start_flow(flow_slug text, input jsonb, run_id uuid)
            RETURNS SETOF pgflow.runs LANGUAGE sql AS $$
                INSERT INTO pgflow.runs(run_id, flow_slug, input) VALUES ($3, $1, $2) RETURNING *
            $$;
        `);
        const request = { flow_slug: "single", input: { message: "hello" }, idempotency_key: "one" };
        const task = await service.startPgflowTask("alpha", request);
        expect(task.status).toBe("pending");
        expect((await service.startPgflowTask("alpha", request)).id).toBe(task.id);
        await expect(service.startPgflowTask("alpha", { ...request, input: {} })).rejects.toThrow("another request");
        await expect(service.startPgflowTask("missing", request)).rejects.toThrow("Project not found");
        enabled = false;
        await expect(service.startPgflowTask("alpha", request)).rejects.toThrow("not enabled");
        enabled = true;
        await expect(service.startPgflowTask("alpha", { ...request, flow_slug: "unknown" })).rejects.toThrow("not registered");
        await expect(service.startPgflowTask("alpha", { ...request, input: undefined })).rejects.toThrow("missing");
        await expect(service.startPgflowTask("alpha", { ...request, input: "x".repeat(262144) })).rejects.toThrow("256 KiB");

        await service.reconcilePgflowTask(task.id, "another-project");
        expect(await database`SELECT * FROM pgflow.runs`).toHaveLength(0);
        await Promise.all([
            service.reconcilePgflowTask(task.id, "alpha"),
            service.reconcilePgflowTask(task.id, "alpha"),
        ]);
        expect(await database`SELECT * FROM pgflow.runs`).toHaveLength(1);
        const [running] = await database`SELECT * FROM project_tasks WHERE id = ${task.id}::uuid`;
        expect(running.status).toBe("running");
        await database`
            INSERT INTO pgflow.step_states(run_id, step_slug, status, started_at)
            VALUES (${task.id}::uuid, 'approval', 'started', NOW())
        `;
        await database`
            INSERT INTO pgflow.step_tasks(run_id, step_slug, status, attempts_count, started_at)
            VALUES (${task.id}::uuid, 'approval', 'started', 1, NOW())
        `;
        const observed = await service.list("alpha", { limit: 20 });
        expect(observed).toHaveLength(1);
        expect(observed[0]).toMatchObject({
            id: `pgflow:${task.id}`,
            project_ref: "alpha",
            status: "running",
            total_steps: 1,
            finished_steps: 0,
            result: null,
        });
        expect(observed[0]?.executor).toMatchObject({
            kind: "pgflow",
            definition: "single",
            run_id: task.id,
        });
        expect("input" in (observed[0] ?? {})).toBe(false);
        await database`UPDATE pgflow.runs SET status = 'completed', output = '["done"]'::jsonb,
            completed_at = NOW() WHERE run_id = ${task.id}::uuid`;
        await database`UPDATE pgflow.step_states SET status = 'completed', completed_at = NOW()
            WHERE run_id = ${task.id}::uuid AND step_slug = 'approval'`;
        await database`UPDATE pgflow.step_tasks SET status = 'completed', completed_at = NOW()
            WHERE run_id = ${task.id}::uuid AND step_slug = 'approval'`;
        await service.reconcilePgflowTask(task.id, "alpha");
        const [completed] = await database`SELECT * FROM project_tasks WHERE id = ${task.id}::uuid`;
        expect(completed.status).toBe("succeeded");
        expect(completed.result).toEqual({ output: ["done"] });
        const completedObserved = await service.get("alpha", `pgflow:${task.id}`);
        expect(completedObserved?.status).toBe("succeeded");
        expect(completedObserved?.result).toBeNull();
        expect(await service.list("alpha", { limit: 20, statuses: ["running"] })).toHaveLength(0);

        for (const value of [null, false, 42, "hello", [1, { nested: true }]]) {
            const inputTask = await service.startPgflowTask("alpha", {
                flow_slug: "parallel", input: value, idempotency_key: crypto.randomUUID(),
            });
            await service.reconcilePgflowTask(inputTask.id, "alpha");
            await service.reconcilePgflowTask(inputTask.id, "alpha");
            const [run] = await database`SELECT input FROM pgflow.runs WHERE run_id = ${inputTask.id}::uuid`;
            expect(run.input).toEqual(value);
        }

        const recovery = await service.startPgflowTask("alpha", { ...request, idempotency_key: "recovery" });
        await database.unsafe(`
            CREATE FUNCTION reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW.status = 'running' THEN RAISE EXCEPTION 'injected receipt failure'; END IF;
                RETURN NEW;
            END $$;
            CREATE TRIGGER receipt_failure BEFORE UPDATE ON project_tasks
                FOR EACH ROW EXECUTE FUNCTION reject_receipt();
        `);
        await expect(service.reconcilePgflowTask(recovery.id, "alpha")).rejects.toThrow("injected");
        expect(await database`SELECT * FROM pgflow.runs WHERE run_id = ${recovery.id}::uuid`).toHaveLength(1);
        await database.unsafe("DROP TRIGGER receipt_failure ON project_tasks");
        await service.reconcilePgflowTask(recovery.id, "alpha");
        expect(await database`SELECT * FROM pgflow.runs WHERE run_id = ${recovery.id}::uuid`).toHaveLength(1);
        await database`UPDATE pgflow.runs SET status = 'failed', failed_at = NOW()
            WHERE run_id = ${recovery.id}::uuid`;
        await service.reconcilePgflowTask(recovery.id, "alpha");
        const [failed] = await database`SELECT status FROM project_tasks WHERE id = ${recovery.id}::uuid`;
        expect(failed.status).toBe("failed");
        expect(() => service.pgflowTaskStatus("cancelled")).toThrow("Unsupported");

        const lost = await service.startPgflowTask("alpha", { ...request, idempotency_key: "lost" });
        await service.reconcilePgflowTask(lost.id, "alpha");
        await database`DELETE FROM pgflow.runs WHERE run_id = ${lost.id}::uuid`;
        await expect(service.reconcilePgflowTask(lost.id, "alpha")).rejects.toThrow("refusing to replay");
    }),
    60_000,
);
