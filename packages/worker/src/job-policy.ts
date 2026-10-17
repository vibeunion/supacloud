export interface JobRetryPolicy {
  /** Retry budget after the first execution, matching pgflow's retry.limit. */
  readonly maxRetries: number;
  readonly baseDelaySeconds: number;
  readonly maxDelaySeconds: number;
  /** Metadata only; PGMQ dequeue ordering is unchanged. */
  readonly priority: number;
}

export interface JobPolicyInput {
  readonly maxRetries?: number;
  readonly baseDelaySeconds?: number;
  readonly maxDelaySeconds?: number;
  readonly priority?: number;
}

export function normalizeJobPolicy(input: JobPolicyInput = {}): JobRetryPolicy {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !["maxRetries", "baseDelaySeconds", "maxDelaySeconds", "priority"].includes(key))) {
    throw new Error("WORKER_RETRY_POLICY_INVALID");
  }
  const policy = {
    maxRetries: integer(input.maxRetries, 5, 0, 100),
    baseDelaySeconds: integer(input.baseDelaySeconds, 5, 0, 86400),
    maxDelaySeconds: integer(input.maxDelaySeconds, 300, 0, 86400),
    priority: integer(input.priority, 0, -1000, 1000),
  };
  if (policy.maxDelaySeconds < policy.baseDelaySeconds) throw new Error("WORKER_RETRY_POLICY_INVALID");
  return Object.freeze(policy);
}

/** Delay after a failed 1-based execution attempt; zero also permits immediate retries. */
export function retryDelaySeconds(policy: JobRetryPolicy, attempt: number): number {
  const captured = normalizeJobPolicy(policy);
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("WORKER_RETRY_ATTEMPT_INVALID");
  if (attempt > captured.maxRetries) return 0;
  return Math.min(captured.maxDelaySeconds, captured.baseDelaySeconds * 2 ** (attempt - 1));
}

export function validateJobKey(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || !/^[A-Za-z0-9_.:@/-]{1,200}$/.test(value)) {
    throw new Error("WORKER_JOB_KEY_INVALID");
  }
  return value;
}

export function validateQueueName(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(value)
    || value.startsWith("supacloud_internal_")) throw new Error("WORKER_QUEUE_INVALID");
  return value;
}

export function stableJobKey(queueName: string, jobKey: string): string {
  return validateJobKey(`${validateQueueName(queueName)}:${validateJobKey(jobKey)}`);
}

function integer(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error("WORKER_RETRY_POLICY_INVALID");
  return result;
}
