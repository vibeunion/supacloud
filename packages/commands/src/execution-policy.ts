import { emitCommandObservation, type CommandObserver } from "./observation";

export class ExecutionPolicyError extends Error {
  constructor(readonly code: "CIRCUIT_OPEN" | "EXECUTION_ABORTED" | "EXECUTION_TIMEOUT" | "COMMAND_OUTCOME_UNKNOWN") {
    super(code);
    this.name = "ExecutionPolicyError";
  }
}

type RetryDecision = "retry" | "rolled-back" | "stop";
export interface ExecutionPolicyEvent {
  kind: "read" | "command";
  attempt: number;
  phase: "started" | "succeeded" | "failed" | "retry" | "rejected";
  reason?: RetryDecision | ExecutionPolicyError["code"];
}

export interface ExecutionPolicyOptions {
  kind: "read" | "command";
  /** Metadata only. Attach operation/trace labels in the host's observer closure. */
  observer?: CommandObserver<ExecutionPolicyEvent>;
  /** Cooperative cancellation. The operation must forward the signal to its driver. */
  timeoutMs?: number;
  retry?: {
    maxAttempts: number;
    delayMs: number;
    /** Commands may retry only a driver-confirmed rollback, never an unknown outcome. */
    classify(error: unknown): RetryDecision;
  };
  circuit?: {
    failureThreshold: number;
    resetAfterMs: number;
    /** Exclude authorization, validation and business-rule rejection. */
    isFailure(error: unknown): boolean;
  };
}

/** One instance per named operation/authority boundary, explicitly constructed by the host. */
export function createExecutionPolicy(options: ExecutionPolicyOptions) {
  const retry = options.retry ? { ...options.retry } : undefined;
  const circuit = options.circuit ? { ...options.circuit } : undefined;
  const { kind, timeoutMs, observer } = options;
  const emit = (event: Omit<ExecutionPolicyEvent, "kind">) =>
    emitCommandObservation(observer, { kind, ...event });
  for (const value of [timeoutMs, retry?.maxAttempts, retry?.delayMs, circuit?.failureThreshold, circuit?.resetAfterMs]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)) {
      throw new TypeError("Execution policy values must be positive bounded integers");
    }
  }
  let failures = 0;
  let openUntil = 0;
  let probe = false;
  let generation = 0;

  return Object.freeze({
    async execute<Result>(run: (signal: AbortSignal) => Promise<Result>, parent?: AbortSignal): Promise<Result> {
      if (parent?.aborted) {
        emit({ attempt: 0, phase: "rejected", reason: "EXECUTION_ABORTED" });
        throw new ExecutionPolicyError("EXECUTION_ABORTED");
      }
      const halfOpen = openUntil !== 0;
      if (halfOpen && (Date.now() < openUntil || probe)) {
        emit({ attempt: 0, phase: "rejected", reason: "CIRCUIT_OPEN" });
        throw new ExecutionPolicyError("CIRCUIT_OPEN");
      }
      if (halfOpen) probe = true;
      const currentGeneration = generation;
      const controller = new AbortController();
      let expired = false;
      const abort = () => controller.abort();
      parent?.addEventListener("abort", abort, { once: true });
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        expired = true;
        controller.abort();
      }, timeoutMs);
      const cancelled = () => new ExecutionPolicyError(kind === "command"
        ? "COMMAND_OUTCOME_UNKNOWN" : expired ? "EXECUTION_TIMEOUT" : "EXECUTION_ABORTED");
      try {
        for (let attempt = 1; ; attempt++) {
          if (controller.signal.aborted) {
            emit({ attempt, phase: "rejected", reason: cancelled().code });
            throw cancelled();
          }
          try {
            emit({ attempt, phase: "started" });
            // Never race a write against a timer: retain ownership until its driver settles.
            const result = await run(controller.signal);
            if (controller.signal.aborted) throw cancelled();
            if (currentGeneration === generation) {
              failures = 0;
              if (halfOpen) { openUntil = 0; generation++; }
            }
            emit({ attempt, phase: "succeeded" });
            return result;
          } catch (error) {
            const unknownOutcome = kind === "command" && error !== null && typeof error === "object"
              && "code" in error && error.code === "COMMAND_OUTCOME_UNKNOWN";
            emit({
              attempt, phase: "failed",
              ...(controller.signal.aborted ? { reason: cancelled().code }
                : unknownOutcome ? { reason: "COMMAND_OUTCOME_UNKNOWN" as const } : {}),
            });
            if (controller.signal.aborted) throw cancelled();
            if (unknownOutcome) throw error;
            if (!retry || halfOpen || attempt >= retry.maxAttempts) throw error;
            const decision = retry.classify(error);
            if (decision !== "rolled-back" && !(kind === "read" && decision === "retry")) throw error;
            emit({ attempt, phase: "retry", reason: decision });
            await new Promise<void>((resolve) => {
              const done = () => { clearTimeout(wait); controller.signal.removeEventListener("abort", done); resolve(); };
              const wait = setTimeout(done, retry.delayMs);
              controller.signal.addEventListener("abort", done, { once: true });
            });
          }
        }
      } catch (error) {
        if (circuit && currentGeneration === generation) {
          if (circuit.isFailure(error)) {
            failures++;
            if (halfOpen || failures >= circuit.failureThreshold) {
              openUntil = Date.now() + circuit.resetAfterMs;
              generation++;
            }
          } else if (halfOpen) {
            openUntil = 0;
            failures = 0;
            generation++;
          }
        }
        throw error;
      } finally {
        clearTimeout(timer);
        parent?.removeEventListener("abort", abort);
        if (halfOpen) probe = false;
      }
    },
  });
}
