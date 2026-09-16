import { compareApprovalOutcome, type ApprovalComparison, type ApprovalEvaluation, type ApprovalObservation } from './index.js';
import { immutableData } from './validation.js';

export interface ApprovalShadowMetric extends ApprovalComparison {
  readonly schema: 'supacloud.approval.shadow.v1';
}

export interface ApprovalShadowOptions<Result, State extends string> {
  /** Disabled by default. The original command is always called exactly once. */
  readonly enabled?: boolean;
  /** Capture immutable facts before the command; this callback must be synchronous and bounded. */
  readonly predict: () => ApprovalEvaluation<State>;
  /** Decode the original validated command response, not a later mutable database read. */
  readonly observe: (result: Result) => ApprovalObservation<State>;
  /** Must enqueue bounded local telemetry, not perform blocking I/O. Errors are isolated. */
  readonly record?: (metric: ApprovalShadowMetric) => void | Promise<void>;
}

/** Never gates, retries, catches-and-replaces, or compensates the original business command. */
export async function runApprovalShadow<Result, State extends string>(
  execute: () => Promise<Result>,
  options: ApprovalShadowOptions<Result, State>,
): Promise<Result> {
  if (options.enabled !== true) return execute();
  let prediction: ApprovalEvaluation<State> | undefined;
  try {
    const result = options.predict();
    if (result && typeof result === 'object' && 'then' in result) {
      void Promise.resolve(result).catch(() => undefined);
    } else {
      prediction = immutableData(result, 'observation');
    }
  } catch {
    prediction = undefined;
  }
  const record = (comparison: ApprovalComparison): void => {
    try {
      // No identifiers, facts, arbitrary errors, guard text or receipt payloads enter telemetry.
      void Promise.resolve(options.record?.(Object.freeze({
        schema: 'supacloud.approval.shadow.v1', ...comparison,
      }))).catch(() => undefined);
    } catch {
      // Observability must not turn a committed approval into a failed request.
    }
  };
  let result: Result;
  try {
    result = await execute();
  } catch (error) {
    record({ kind: 'inconclusive', reason: 'command_outcome_unknown' });
    throw error;
  }
  if (!prediction) {
    record({ kind: 'inconclusive', reason: 'prediction_unavailable' });
    return result;
  }
  try {
    const observation = options.observe(result);
    if (observation && typeof observation === 'object' && 'then' in observation) {
      void Promise.resolve(observation).catch(() => undefined);
      record({ kind: 'inconclusive', reason: 'observation_unavailable' });
    } else {
      record(compareApprovalOutcome(prediction, observation));
    }
  } catch {
    record({ kind: 'inconclusive', reason: 'observation_unavailable' });
  }
  return result;
}
