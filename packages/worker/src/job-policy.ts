export interface JobRetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelaySeconds: number;
  readonly maxDelaySeconds: number;
  readonly priority: number;
}

export interface JobPolicyInput {
  readonly maxAttempts?: number;
  readonly baseDelaySeconds?: number;
  readonly maxDelaySeconds?: number;
  readonly priority?: number;
}

const DEFAULT_POLICY: JobRetryPolicy = {
  maxAttempts: 5,
  baseDelaySeconds: 5,
  maxDelaySeconds: 300,
  priority: 0,
};

export function normalizeJobPolicy(input: JobPolicyInput = {}): JobRetryPolicy {
  const policy = {
    maxAttempts: integer(input.maxAttempts, DEFAULT_POLICY.maxAttempts, 0, 100),
    baseDelaySeconds: integer(input.baseDelaySeconds, DEFAULT_POLICY.baseDelaySeconds, 0, 86400),
    maxDelaySeconds: integer(input.maxDelaySeconds, DEFAULT_POLICY.maxDelaySeconds, 0, 86400),
    priority: integer(input.priority, DEFAULT_POLICY.priority, -1000, 1000),
  };
  if (policy.maxDelaySeconds < policy.baseDelaySeconds) {
    throw new Error("WORKER_RETRY_POLICY_INVALID");
  }
  return Object.freeze(policy);
}

export function retryDelaySeconds(policy: JobRetryPolicy, attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("WORKER_RETRY_ATTEMPT_INVALID");
  }
  if (policy.maxAttempts === 0 || attempt > policy.maxAttempts) return 0;
  return Math.min(policy.maxDelaySeconds, policy.baseDelaySeconds * 2 ** (attempt - 1));
}

export function validateJobKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200
    || value.trim() !== value || !/^[A-Za-z0-9_.:@/-]+$/.test(value)) {
    throw new Error("WORKER_JOB_KEY_INVALID");
  }
  return value;
}

export function stableJobKey(queueName: string, jobKey: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(queueName)) {
    throw new Error("WORKER_QUEUE_INVALID");
  }
  return `${queueName}:${validateJobKey(jobKey)}`;
}

function integer(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new Error("WORKER_RETRY_POLICY_INVALID");
  }
  return result;
}
