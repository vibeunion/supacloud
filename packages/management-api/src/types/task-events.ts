/**
 * Task Lifecycle Event types.
 *
 * These events are emitted by the platform whenever a background task transitions
 * state. Business systems (e.g. AoristCross) can consume them to keep their own
 * `public.tasks` in sync without depending on the platform mirror table schema.
 *
 * Design decision: events carry correlation metadata (`correlation_id`,
 * `business_task_id`, `metadata`) so the consumer can map back to its own
 * records without parsing platform-internal payload structure.
 */

export type TaskLifecycleEventType =
  | "task.created"
  | "task.running"
  | "task.succeeded"
  | "task.failed"
  | "task.retry_scheduled"
  | "task.dead_lettered"
  | "task.cancelled";

export interface TaskLifecycleEvent {
  /** Event type (e.g. task.running, task.succeeded) */
  event_type: TaskLifecycleEventType;

  /** Platform task ID (project_tasks.id) */
  task_id: string;

  /** Project ref */
  project_ref: string;

  /** Task type (e.g. "edge_function", "queue:emails") */
  task_type: string;

  /** Function slug, if applicable */
  function_slug: string | null;

  /** Current attempt number (1-based) */
  attempt: number;

  /** Max attempts */
  max_attempts: number;

  /** Current status string */
  status: string;

  /** Error message, if failed/dead_lettered/cancelled */
  error: string | null;

  /** Correlation ID set by the submitter */
  correlation_id: string | null;

  /** Business task ID set by the submitter */
  business_task_id: string | null;

  /** Arbitrary metadata set by the submitter */
  metadata: Record<string, unknown> | null;

  /** ISO 8601 timestamp of the event */
  timestamp: string;
}

/** Build a TaskLifecycleEvent from a ProjectTask + event type */
export function buildTaskLifecycleEvent(
  eventType: TaskLifecycleEventType,
  task: {
    id: string;
    project_ref: string;
    task_type: string;
    function_slug: string | null;
    attempt: number;
    max_attempts: number;
    status: string;
    error: string | null;
    correlation_id: string | null;
    business_task_id: string | null;
    metadata: Record<string, unknown> | null;
  },
  error?: string | null,
): TaskLifecycleEvent {
  const statusByEventType: Record<TaskLifecycleEventType, string> = {
    "task.created": "pending",
    "task.running": "running",
    "task.succeeded": "succeeded",
    "task.failed": "failed",
    "task.retry_scheduled": "retry_scheduled",
    "task.dead_lettered": "dead_lettered",
    "task.cancelled": "cancelled",
  };

  return {
    event_type: eventType,
    task_id: task.id,
    project_ref: task.project_ref,
    task_type: task.task_type,
    function_slug: task.function_slug,
    attempt: task.attempt || 1,
    max_attempts: task.max_attempts || 3,
    status: statusByEventType[eventType] || task.status,
    error: error ?? task.error,
    correlation_id: task.correlation_id,
    business_task_id: task.business_task_id,
    metadata: task.metadata,
    timestamp: new Date().toISOString(),
  };
}
