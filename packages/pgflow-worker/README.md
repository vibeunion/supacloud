# Self-Hosted pgflow Worker

This service runs one trusted project's flow in a separate Bun process. It
connects directly to that project's PostgreSQL database, not the Management
API. Dependencies are pinned and installed when building the image.

## Acceptance Contract

1. Given an enabled project and no Management API or Supabase cloud service,
   when a task is queued, then the process worker completes it using PostgreSQL.
2. Given a worker killed after claiming a task, when its lease expires and a
   replacement worker starts, then recovery requeues and completes the task.
3. Given a paused project, when queued work exists, then no new task starts;
   accepted tasks may finish and resume continues without deleting history.
4. Given the runtime database role, when it attempts to update platform state
   or call the ungated claim functions, then PostgreSQL denies the operation.

## Configuration

Provide these as runtime secrets/environment, never in the image:

- `DATABASE_URL`: direct connection to the project's database, using a
  dedicated non-superuser login with the required pgflow/PGMQ privileges.
  Never supply the control-plane database connection.
- `SUPABASE_URL`: the project's own SupaCloud API URL. The name is an upstream
  compatibility variable, not a requirement to use a hosted cloud domain.
- `SUPABASE_SERVICE_ROLE_KEY`: the same project's key; used only if handlers
  call the upstream client.
- `WORKER_NAME`: stable worker name, letters/digits/underscore/hyphen, up to 128.
- `PGFLOW_FLOW_MODULE`: absolute path to a trusted TypeScript module exporting
  its pgflow `Flow` as `default`. Default: `/flows/flow.ts`.

## Deployment

1. Enable `pgflow` for the project from the console or CLI.
2. Create a unique project worker login with `LOGIN`, `NOSUPERUSER`,
   `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT` and a generated password using your
   normal database-role provisioning. Do not grant the shared `service_role`
   role or reuse the login in other project databases.
3. With a deployment-only connection to that project, run `src/compile.ts`
   with `DATABASE_URL`, `PGFLOW_WORKER_ROLE` and `PGFLOW_FLOW_MODULE`. This
   compiles the reviewed shape and applies runtime grants in one transaction.
   Shape mismatches fail; they do not delete previous runs.
4. Put only the worker login URL, project API URL/key and `WORKER_NAME` into a
   protected `pgflow-worker.env` file outside version control. Mount the flow
   directory read-only using `PGFLOW_FLOWS_DIR`.
5. Start `docker compose --profile pgflow up -d --build pgflow-worker`.
   The Compose mount places `flow.ts` beneath the bundled dependencies so the
   `@pgflow/dsl` import resolves without installing packages at startup.

Use the same pinned DSL for deployment and execution. The included
`examples/flow.ts` is a test/example, not an automatically deployed business
workflow. Copying credentials between projects is never part of deployment.
Repeat compilation/grants after an explicitly reviewed new flow deployment.

Run one container per project/flow with only its own credentials and code.
Do not mount a multi-project secrets directory or run untrusted flows inside
the Management API. Flow code has the same privileges as the worker process.
The runtime reports readiness only after schema/version validation and worker
startup; it does not install or adopt schemas.

`SIGTERM` stops recovery and drains the upstream worker. Forced termination
can retry a task after lease expiry; handlers must tolerate repeated execution.
Pause is not cancellation of external effects.

The optional `pgflow-http` Compose profile runs the HTTP dispatcher separately
from Management. Only use it for tested compatible Edge Runtime workers.
Already accepted HTTP requests can arrive after pause, but SQL admission
prevents those workers starting new tasks. Process mode is the default
recommended deployment and does not need this dispatcher.
