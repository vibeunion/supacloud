import { TaskStatus, TaskType, type Project, type ProjectTask, type ProjectTaskAttempt } from "../../src/db";

export function taskFixture(overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: "tsk_1", project_ref: "proj_1", task_type: TaskType.EDGE_FUNCTION, status: TaskStatus.LEASED,
    payload: { method: "POST", path: "/work", query: "", headers: {}, body: null, auth: {} },
    error: null, retries: 0, attempt: 1, max_attempts: 3, next_run_at: new Date(0),
    lease_until: new Date(Date.now() + 900_000), started_at: null, completed_at: null,
    timeout_sec: 300, idempotency_key: null, trace_id: "fixture-trace",
    cancel_requested_at: null, cancellation_reason: null, correlation_id: null, business_task_id: null,
    invoker_user_id: null, auth_authority_ref: "proj_1", metadata: null,
    function_slug: "my-function", function_version: "1", result: null,
    created_at: new Date(0), updated_at: new Date(0), ...overrides,
  };
}

export function taskAttemptFixture(overrides: Partial<ProjectTaskAttempt> = {}): ProjectTaskAttempt {
  return {
    id: "att_1", task_id: "tsk_1", project_ref: "proj_1", attempt_no: 1, status: "running",
    started_at: new Date(0), completed_at: null, duration_ms: null, error: null,
    response_status: null, logs: [], created_at: new Date(0), updated_at: new Date(0), ...overrides,
  };
}

export function taskProjectFixture(overrides: Partial<Project> = {}): Project {
  return {
    id: "fixture", ref: "proj_1", organization_id: "fixture", name: "Fixture",
    db_name: "fixture", db_user: "fixture", db_password: "synthetic", jwt_secret: "synthetic",
    anon_key: "synthetic", service_role_key: "synthetic", s3_bucket: "fixture",
    s3_access_key: null, s3_secret_key: null, region: "local", status: "active",
    postgrest_desired: null, postgrest_actual: null, postgrest_health: null, postgrest_port: null,
    postgrest_last_error: null, postgrest_updated_at: null, postgrest_last_reconciled_at: null,
    config: {}, created_at: new Date(0), updated_at: new Date(0), deleted_at: null, ...overrides,
  };
}
