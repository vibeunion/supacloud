export interface ExecutionEvent {
  kind: "route" | "command" | "job";
  operation: string;
  stage: string;
  phase: "started" | "succeeded" | "failed";
  requestId?: string;
  durationMs?: number;
}

/** Metadata only: never receives request bodies, credentials, results or errors. */
export type ExecutionObserver = (event: Readonly<ExecutionEvent>) => void | Promise<void>;

export async function observeExecution<T>(
  observer: ExecutionObserver | undefined,
  event: Pick<ExecutionEvent, "kind" | "operation" | "stage" | "requestId">,
  next: () => T | Promise<T>,
): Promise<T> {
  const emit = (phase: ExecutionEvent["phase"], durationMs?: number) => {
    if (!observer) return;
    try {
      // Telemetry is not an audit adapter and cannot alter a command's outcome.
      Promise.resolve(observer(Object.freeze({ ...event, phase, durationMs }))).catch(() => {});
    } catch {}
  };
  const started = performance.now();
  emit("started");
  try {
    const result = await next();
    emit("succeeded", performance.now() - started);
    return result;
  } catch (error) {
    emit("failed", performance.now() - started);
    throw error;
  }
}

export function executionRequestId(context: unknown): string | undefined {
  if (!context || typeof context !== "object" || !("requestId" in context)) return undefined;
  const value = context.requestId;
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value) ? value : undefined;
}
