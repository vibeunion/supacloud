import type {
  SupaCloudWorkflowAdvanceRequest,
  SupaCloudWorkflowClaim,
  SupaCloudWorkflowClaimResult,
  SupaCloudWorkflowCompleteRequest,
  SupaCloudWorkflowFailRequest,
  SupaCloudWorkflowJson,
  SupaCloudWorkflowRetryRequest,
  SupaCloudWorkflowRun,
  SupaCloudWorkflowsClient,
} from "./workflows.js";

export type SupaCloudWorkflowStepResult =
  | {
      kind: "advance";
      nextStepKey: string;
      output?: SupaCloudWorkflowJson;
      nextInput?: SupaCloudWorkflowJson;
      nextMaxAttempts?: number;
    }
  | {
      kind: "complete";
      stepOutput?: SupaCloudWorkflowJson;
      runOutput?: SupaCloudWorkflowJson;
    }
  | {
      kind: "retry";
      errorMessage: string;
      delaySeconds?: number;
    }
  | {
      kind: "fail";
      errorMessage: string;
    };

export interface SupaCloudWorkflowStepContext {
  readonly runId: string;
  readonly workflowName: string;
  readonly workflowVersion: string;
  readonly stepId: string;
  readonly stepKey: string;
  readonly messageId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly workerId: string;
  readonly signal: AbortSignal;
}

export interface SupaCloudWorkflowStepHandler {
  decode(input: SupaCloudWorkflowJson): unknown;
  authorize(input: unknown, context: SupaCloudWorkflowStepContext): boolean | Promise<boolean>;
  execute(
    input: unknown,
    context: SupaCloudWorkflowStepContext,
  ): SupaCloudWorkflowStepResult | Promise<SupaCloudWorkflowStepResult>;
}

export interface SupaCloudWorkflowDefinition {
  readonly workflowName: string;
  readonly workflowVersion: string;
  readonly stepKey: string;
  readonly handler: SupaCloudWorkflowStepHandler;
}

export interface SupaCloudWorkflowRegistry {
  resolve(
    workflowName: string,
    workflowVersion: string,
    stepKey: string,
  ): SupaCloudWorkflowDefinition | undefined;
}

export interface SupaCloudWorkflowTransport {
  claim(signal: AbortSignal): Promise<SupaCloudWorkflowClaim | null>;
  ack(claim: SupaCloudWorkflowClaim, output: unknown): Promise<SupaCloudWorkflowRun>;
  fail(claim: SupaCloudWorkflowClaim, error: unknown): Promise<SupaCloudWorkflowRun>;
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const workflowError = /^[^\u0000-\u001f\u007f]{1,4000}$/;

function definitionKey(workflowName: string, workflowVersion: string, stepKey: string): string {
  return `${workflowName}\u0000${workflowVersion}\u0000${stepKey}`;
}

function validWorkflowVersion(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 80) return false;
  let count = 0;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (++count > 80 || code === 0 || (code !== undefined && code >= 0xd800 && code <= 0xdfff)) {
      return false;
    }
  }
  return true;
}

function jsonObject(value: unknown): value is SupaCloudWorkflowJson {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeErrorMessage(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && workflowError.test(value);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string" ? error : "WORKFLOW_STEP_FAILED";
  return message.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 4000) || "WORKFLOW_STEP_FAILED";
}

function validStepResult(value: unknown): value is SupaCloudWorkflowStepResult {
  const result = record(value);
  if (!result || typeof result.kind !== "string") return false;
  if (result.kind === "advance") {
    return typeof result.nextStepKey === "string" && identifier.test(result.nextStepKey)
      && (result.output === undefined || jsonObject(result.output))
      && (result.nextInput === undefined || jsonObject(result.nextInput))
      && (result.nextMaxAttempts === undefined
        || (typeof result.nextMaxAttempts === "number" && Number.isSafeInteger(result.nextMaxAttempts)
          && result.nextMaxAttempts >= 1 && result.nextMaxAttempts <= 100));
  }
  if (result.kind === "complete") {
    return (result.stepOutput === undefined || jsonObject(result.stepOutput))
      && (result.runOutput === undefined || jsonObject(result.runOutput));
  }
  if (result.kind === "retry") {
    return safeErrorMessage(result.errorMessage)
      && (result.delaySeconds === undefined
        || (typeof result.delaySeconds === "number" && Number.isSafeInteger(result.delaySeconds)
          && result.delaySeconds >= 0 && result.delaySeconds <= 86400));
  }
  return result.kind === "fail" && safeErrorMessage(result.errorMessage);
}

function validateDefinition(value: SupaCloudWorkflowDefinition): void {
  if (!identifier.test(value.workflowName)
    || !validWorkflowVersion(value.workflowVersion)
    || !identifier.test(value.stepKey)
    || !value.handler
    || typeof value.handler.decode !== "function"
    || typeof value.handler.authorize !== "function"
    || typeof value.handler.execute !== "function") {
    throw new TypeError("WORKFLOW_DEFINITION_INVALID");
  }
}

export function createSupaCloudWorkflowRegistry(
  definitions: readonly SupaCloudWorkflowDefinition[],
): SupaCloudWorkflowRegistry {
  const entries = new Map<string, SupaCloudWorkflowDefinition>();
  for (const definition of definitions) {
    validateDefinition(definition);
    const key = definitionKey(definition.workflowName, definition.workflowVersion, definition.stepKey);
    if (entries.has(key)) throw new TypeError("WORKFLOW_DEFINITION_DUPLICATE");
    const decode = definition.handler.decode;
    const authorize = definition.handler.authorize;
    const execute = definition.handler.execute;
    const handler = Object.freeze({
      decode(input: SupaCloudWorkflowJson) {
        return decode.call(definition.handler, input);
      },
      authorize(input: unknown, context: SupaCloudWorkflowStepContext) {
        return authorize.call(definition.handler, input, context);
      },
      execute(input: unknown, context: SupaCloudWorkflowStepContext) {
        return execute.call(definition.handler, input, context);
      },
    });
    entries.set(key, Object.freeze({
      workflowName: definition.workflowName,
      workflowVersion: definition.workflowVersion,
      stepKey: definition.stepKey,
      handler,
    }));
  }
  return Object.freeze({
    resolve(workflowName: string, workflowVersion: string, stepKey: string) {
      return entries.get(definitionKey(workflowName, workflowVersion, stepKey));
    },
  });
}

export type SupaCloudWorkflowDispatchResult =
  | { readonly status: "idle" }
  | { readonly status: "dead_lettered"; readonly claim: Exclude<SupaCloudWorkflowClaimResult, null> }
  | { readonly status: "discarded"; readonly claim: Exclude<SupaCloudWorkflowClaimResult, null> }
  | { readonly status: "advanced" | "completed" | "retried" | "failed"; readonly run: SupaCloudWorkflowRun };

export class SupaCloudWorkflowDispatchError extends Error {
  constructor(
    readonly code:
      | "WORKFLOW_HANDLER_NOT_FOUND"
      | "WORKFLOW_WORKER_MISMATCH"
      | "WORKFLOW_HANDLER_DECODE_FAILED"
      | "WORKFLOW_HANDLER_AUTHORIZATION_FAILED"
      | "WORKFLOW_HANDLER_EXECUTION_FAILED"
      | "WORKFLOW_HANDLER_RESULT_INVALID",
    readonly claim: SupaCloudWorkflowClaim,
    options?: { cause?: unknown },
  ) {
    super(code);
    if (options?.cause !== undefined) this.cause = options.cause;
    this.name = "SupaCloudWorkflowDispatchError";
  }
}

type WorkflowMutationPort = Pick<
  SupaCloudWorkflowsClient,
  "claim" | "advance" | "complete" | "retry" | "fail"
>;
type WorkflowTransportPort = Pick<
  SupaCloudWorkflowsClient,
  "claim" | "complete" | "retry" | "fail"
>;

function attempt(claim: SupaCloudWorkflowClaim) {
  return {
    stepId: claim.stepId,
    messageId: claim.messageId,
    attempt: claim.attempt,
    workerId: claim.workerId,
  };
}

export function createSupaCloudWorkflowTransport(options: {
  readonly workflows: WorkflowTransportPort;
  readonly workerId: string;
  readonly visibilityTimeoutSeconds?: number;
  readonly retryDelaySeconds?: number;
  readonly acceptClaim?: (claim: SupaCloudWorkflowClaim) => void | Promise<void>;
}): SupaCloudWorkflowTransport {
  const visibilityTimeoutSeconds = options.visibilityTimeoutSeconds ?? 300;
  const retryDelaySeconds = options.retryDelaySeconds ?? 5;
  if (typeof options.workerId !== "string" || options.workerId.length < 1 || options.workerId.length > 200
    || /[\u0000-\u001f\u007f]/.test(options.workerId)) {
    throw new TypeError("WORKFLOW_WORKER_ID_INVALID");
  }
  if (!Number.isSafeInteger(visibilityTimeoutSeconds) || visibilityTimeoutSeconds < 15
    || visibilityTimeoutSeconds > 3600) {
    throw new TypeError("WORKFLOW_VISIBILITY_TIMEOUT_INVALID");
  }
  if (!Number.isSafeInteger(retryDelaySeconds) || retryDelaySeconds < 0 || retryDelaySeconds > 86400) {
    throw new TypeError("WORKFLOW_RETRY_DELAY_INVALID");
  }
  return {
    async claim(signal) {
      signal.throwIfAborted();
      const result = await options.workflows.claim({
        workerId: options.workerId,
        visibilityTimeoutSeconds,
      });
      signal.throwIfAborted();
      if (!result || result.status !== "claimed") return null;
      await options.acceptClaim?.(result);
      signal.throwIfAborted();
      return result;
    },
    async ack(claim, output) {
      if (!jsonObject(output)) throw new TypeError("WORKFLOW_OUTPUT_INVALID");
      return options.workflows.complete({
        ...attempt(claim),
        runOutput: output,
      });
    },
    async fail(claim, error) {
      const request = { ...attempt(claim), errorMessage: errorMessage(error) };
      return claim.attempt < claim.maxAttempts
        ? options.workflows.retry({ ...request, delaySeconds: retryDelaySeconds })
        : options.workflows.fail(request);
    },
  };
}

function claimResult(
  claim: Exclude<SupaCloudWorkflowClaimResult, null>,
): SupaCloudWorkflowDispatchResult {
  if (claim.status === "dead_lettered") return { status: "dead_lettered", claim };
  return { status: "discarded", claim };
}

function abortableDelay(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/**
 * Executes exactly one claimed step. Queue polling, leases and retry budgets
 * remain owned by the Workflow service; an unknown claim is left unsettled.
 */
export function createSupaCloudWorkflowDispatcher(options: {
  readonly workflows: WorkflowMutationPort;
  readonly registry: SupaCloudWorkflowRegistry;
  readonly workerId: string;
  readonly visibilityTimeoutSeconds?: number;
  readonly pollIntervalMs?: number;
}) {
  const {
    workflows,
    registry,
    workerId,
    visibilityTimeoutSeconds = 300,
    pollIntervalMs = 250,
  } = options;
  if (typeof workerId !== "string" || workerId.length < 1 || workerId.length > 200
    || /[\u0000-\u001f\u007f]/.test(workerId)) {
    throw new TypeError("WORKFLOW_WORKER_ID_INVALID");
  }
  if (!Number.isSafeInteger(visibilityTimeoutSeconds) || visibilityTimeoutSeconds < 15
    || visibilityTimeoutSeconds > 3600) {
    throw new TypeError("WORKFLOW_VISIBILITY_TIMEOUT_INVALID");
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 60000) {
    throw new TypeError("WORKFLOW_POLL_INTERVAL_INVALID");
  }

  const dispatchOnce = async (
    signal: AbortSignal = new AbortController().signal,
  ): Promise<SupaCloudWorkflowDispatchResult> => {
      signal.throwIfAborted();
      const claimed = await workflows.claim({ workerId, visibilityTimeoutSeconds });
      if (claimed === null) return { status: "idle" };
      if (claimed.status !== "claimed") return claimResult(claimed);
      if (claimed.workerId !== workerId) {
        throw new SupaCloudWorkflowDispatchError("WORKFLOW_WORKER_MISMATCH", claimed);
      }

      const definition = registry.resolve(
        claimed.workflowName,
        claimed.workflowVersion,
        claimed.stepKey,
      );
      if (!definition) {
        throw new SupaCloudWorkflowDispatchError("WORKFLOW_HANDLER_NOT_FOUND", claimed);
      }

      const context: SupaCloudWorkflowStepContext = Object.freeze({
        runId: claimed.runId,
        workflowName: claimed.workflowName,
        workflowVersion: claimed.workflowVersion,
        stepId: claimed.stepId,
        stepKey: claimed.stepKey,
        messageId: claimed.messageId,
        attempt: claimed.attempt,
        maxAttempts: claimed.maxAttempts,
        workerId,
        signal,
      });
      let input: unknown;
      try {
        input = definition.handler.decode(claimed.input);
      } catch (error) {
        throw new SupaCloudWorkflowDispatchError("WORKFLOW_HANDLER_DECODE_FAILED", claimed, { cause: error });
      }
      signal.throwIfAborted();
      let authorized: boolean;
      try {
        authorized = await definition.handler.authorize(input, context);
      } catch (error) {
        throw new SupaCloudWorkflowDispatchError("WORKFLOW_HANDLER_AUTHORIZATION_FAILED", claimed, { cause: error });
      }
      if (authorized !== true) {
        signal.throwIfAborted();
        const request: SupaCloudWorkflowFailRequest = {
          ...attempt(claimed),
          errorMessage: "WORKFLOW_STEP_FORBIDDEN",
        };
        return { status: "failed", run: await workflows.fail(request) };
      }
      signal.throwIfAborted();
      let result: unknown;
      try {
        result = await definition.handler.execute(input, context);
      } catch (error) {
        throw new SupaCloudWorkflowDispatchError("WORKFLOW_HANDLER_EXECUTION_FAILED", claimed, { cause: error });
      }
      signal.throwIfAborted();
      if (!validStepResult(result)) {
        throw new SupaCloudWorkflowDispatchError("WORKFLOW_HANDLER_RESULT_INVALID", claimed);
      }

      if (result.kind === "advance") {
        const request: SupaCloudWorkflowAdvanceRequest = {
          ...attempt(claimed),
          output: result.output,
          nextStepKey: result.nextStepKey,
          nextInput: result.nextInput,
          nextMaxAttempts: result.nextMaxAttempts,
        };
        return { status: "advanced", run: await workflows.advance(request) };
      }
      if (result.kind === "complete") {
        const request: SupaCloudWorkflowCompleteRequest = {
          ...attempt(claimed),
          stepOutput: result.stepOutput,
          runOutput: result.runOutput,
        };
        return { status: "completed", run: await workflows.complete(request) };
      }
      if (result.kind === "retry") {
        const request: SupaCloudWorkflowRetryRequest = {
          ...attempt(claimed),
          errorMessage: result.errorMessage,
          delaySeconds: result.delaySeconds,
        };
        return { status: "retried", run: await workflows.retry(request) };
      }
      const request: SupaCloudWorkflowFailRequest = {
        ...attempt(claimed),
        errorMessage: result.errorMessage,
      };
      return { status: "failed", run: await workflows.fail(request) };
  };

  return {
    dispatchOnce,
    async run(signal: AbortSignal = new AbortController().signal): Promise<void> {
      try {
        while (!signal.aborted) {
          const result = await dispatchOnce(signal);
          if (result.status === "idle") await abortableDelay(signal, pollIntervalMs);
        }
      } catch (error) {
        if (signal.aborted && error === signal.reason) return;
        throw error;
      }
    },
  };
}
