/**
 * Runtime-independent Job test harness.
 *
 * The runner and decoders are injected so this package does not depend on
 * TypeBox, Elysia, or a platform adapter at runtime.
 */

export type JobDecoder<T> = (value: unknown) => T;

export interface JobTestContext {
  readonly jobId: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
  readonly now: () => Date;
}

export type JobRunner<TInput, TOutput> = (
  input: TInput,
  context: JobTestContext,
) => TOutput | Promise<TOutput>;

export interface JobHarnessOptions<TInput, TOutput> {
  /** Raw value passed through inputDecoder before the runner starts. */
  input: unknown;
  runner: JobRunner<TInput, TOutput>;
  inputDecoder?: JobDecoder<TInput>;
  outputDecoder?: JobDecoder<TOutput>;
  jobId?: string;
  attempt?: number;
  now?: () => Date;
}

export type JobContractBoundary = "input" | "output";

export class JobContractError extends Error {
  readonly code: "JOB_INPUT_VALIDATION_ERROR" | "JOB_OUTPUT_VALIDATION_ERROR";

  constructor(readonly boundary: JobContractBoundary) {
    super(boundary === "input"
      ? "Job input contract validation failed"
      : "Job output contract validation failed");
    this.name = "JobContractError";
    this.code = boundary === "input"
      ? "JOB_INPUT_VALIDATION_ERROR"
      : "JOB_OUTPUT_VALIDATION_ERROR";
  }
}

export class JobCancelledError extends Error {
  readonly code = "JOB_CANCELLED";

  constructor() {
    super("Job execution cancelled");
    this.name = "JobCancelledError";
  }
}

export interface JobHarness<TOutput> {
  readonly context: JobTestContext;
  readonly promise: Promise<TOutput>;
  cancel(reason?: unknown): void;
}

function validateJobId(value: string | undefined): string {
  const jobId = value ?? "test-job";
  if (jobId.length === 0 || jobId.length > 200 || /[\u0000-\u001f\u007f]/.test(jobId)) {
    throw new TypeError("createJobHarness: jobId must be a safe non-empty string");
  }
  return jobId;
}

function validateAttempt(value: number | undefined): number {
  const attempt = value ?? 1;
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new TypeError("createJobHarness: attempt must be a positive integer");
  }
  return attempt;
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new JobCancelledError();
}

function decode<T>(
  decoder: JobDecoder<T> | undefined,
  value: unknown,
  boundary: JobContractBoundary,
): T {
  if (!decoder) return value as T;
  try {
    return decoder(value);
  } catch {
    throw new JobContractError(boundary);
  }
}

/** Create a cancellable, deterministic Job execution for unit tests. */
export function createJobHarness<TInput = unknown, TOutput = unknown>(
  options: JobHarnessOptions<TInput, TOutput>,
): JobHarness<TOutput> {
  const controller = new AbortController();
  const context = Object.freeze({
    jobId: validateJobId(options.jobId),
    attempt: validateAttempt(options.attempt),
    signal: controller.signal,
    now: options.now ?? (() => new Date()),
  });

  let settled = false;
  let rejectCancellation: ((reason?: unknown) => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    rejectCancellation = reject;
  });
  const execution = Promise.resolve().then(async () => {
    throwIfCancelled(context.signal);
    const input = decode(options.inputDecoder, options.input, "input");
    throwIfCancelled(context.signal);
    const output = await options.runner(input, context);
    throwIfCancelled(context.signal);
    return decode(options.outputDecoder, output, "output");
  });
  const tracked = execution.finally(() => {
    settled = true;
  });
  const promise = Promise.race([tracked, cancellation]);

  return {
    context,
    promise,
    cancel(reason?: unknown): void {
      if (settled || controller.signal.aborted) return;
      const error = new JobCancelledError();
      controller.abort(reason ?? error);
      rejectCancellation?.(error);
    },
  };
}

/** Run one Job directly when cancellation control is not needed by the test. */
export async function runJob<TInput = unknown, TOutput = unknown>(
  options: JobHarnessOptions<TInput, TOutput>,
): Promise<TOutput> {
  return createJobHarness(options).promise;
}
