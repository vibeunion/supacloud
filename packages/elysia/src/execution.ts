// Keep the adapter import path stable; execution telemetry is transport-neutral.
export {
  executionRequestId,
  executionTrace,
  observeExecution,
} from "@supacloud/app/execution";
export type { ExecutionEvent, ExecutionObserver } from "@supacloud/app/execution";
