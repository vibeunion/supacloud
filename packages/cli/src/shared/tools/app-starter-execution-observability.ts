export const STARTER_EXECUTION_OBSERVABILITY = `import type { ExecutionObserver } from "@supacloud/elysia";

function correlationId(value: string | undefined): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value) ? value : undefined;
}

function createObserver(source: "http" | "worker", workerId?: string): ExecutionObserver {
  return metadata => {
    // Select fields explicitly: future observer extensions must not leak payloads.
    console.info(JSON.stringify({
      event: source === "http" ? "review-http-execution" : "review-worker-execution",
      component: source === "http" ? "review-http" : "review-attachment-worker",
      timestamp: new Date().toISOString(),
      workerId: correlationId(workerId),
      kind: metadata.kind,
      operation: metadata.operation,
      stage: metadata.stage,
      phase: metadata.phase,
      requestId: correlationId(metadata.requestId),
      durationMs: typeof metadata.durationMs === "number" && Number.isFinite(metadata.durationMs)
        && metadata.durationMs >= 0 ? metadata.durationMs : undefined,
    }));
  };
}

export function createReviewHttpObserver(): ExecutionObserver {
  return createObserver("http");
}

export function createReviewWorkerObserver(workerId: string): ExecutionObserver {
  return createObserver("worker", workerId);
}
`;

export const STARTER_WORKER_OBSERVABILITY = `export { createReviewWorkerObserver } from "./review-execution-observability";
`;
