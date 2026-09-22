import type { BackgroundSettings, TaskDetail } from "./task-center";

export const taskId = "12345678-abcd-4321-abcd-123456789012";
export const otherTaskId = "87654321-abcd-4321-abcd-123456789012";
export const taskTime = "2026-09-09T01:02:03.000Z";
export const backgroundSettings: BackgroundSettings = {
  concurrency: 30, max_attempts: 3, max_payload_bytes: 262144,
  timeout_sec_default: 300, timeout_sec_max: 900,
};
export function taskFixture(projectRef = "a", id = taskId): TaskDetail {
  return {
    id, project_ref: projectRef, task_type: "queue:work", status: "failed",
    error: "Task failed", function_slug: null, function_version: null, attempt: 1, max_attempts: 3,
    created_at: taskTime, updated_at: taskTime, cancel_requested_at: null, cancellation_reason: null,
    lease_until: null, next_run_at: null, completed_at: taskTime,
    attempts: [{
      id: "00000000-0000-4000-8000-000000000001", task_id: id, project_ref: projectRef,
      attempt_no: 1, status: "failed", started_at: taskTime, completed_at: taskTime, duration_ms: 0,
      error: "Task failed", response_status: 500,
      logs: [{ timestamp: taskTime, stream: "stderr", level: "error", message: "Task failed" }],
    }],
    latest_logs: [{ timestamp: taskTime, stream: "stderr", level: "error", message: "Task failed" }],
  };
}
