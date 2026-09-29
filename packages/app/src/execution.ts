/**
 * Portable, explicit application execution. This entry point has no Elysia,
 * Angular, reflection, database, or HTTP-host runtime dependency.
 */
import type { Aspect } from "./aspect";
import type { CommandRuntimeCapabilities, CommandRuntimeInvocation } from "./command_runtime";
import { executionTrace, observeExecution, type ExecutionObserver } from "./execution_observer";

export { executionRequestId, executionTrace, observeExecution } from "./execution_observer";
export type { ExecutionEvent, ExecutionObserver } from "./execution_observer";
export type { Aspect, AspectContext, AspectKind, AspectNext } from "./aspect";

export type ExecutionNext<Result = unknown> = () => Result | Promise<Result>;
export type ExecutionMiddleware<Context, Result = unknown> = (
  context: Context,
  next: ExecutionNext<Result>,
) => Result | Promise<Result>;

/** Public configuration/continuation failures; never contains invocation input. */
export class ExecutionPipelineError extends Error {
  readonly expose = true as const;
  constructor(
    message: string,
    readonly code: string,
    readonly status = 500,
  ) {
    super(message);
    this.name = "ExecutionPipelineError";
  }
}

/**
 * First declared is outermost. Every continuation is single-use and is closed
 * when its owning middleware settles. Retry belongs to a durable executor,
 * never to reusing next(). Middleware must return or await next().
 */
export function composeExecution<Context, Result = unknown>(
  ...middleware: ExecutionMiddleware<Context, Result>[]
): ExecutionMiddleware<Context, Result> {
  const steps = middleware.slice();
  if (steps.some((step) => typeof step !== "function")) {
    throw new TypeError("Execution middleware must be callable");
  }
  return async (context, handler) => {
    const dispatch = async (index: number): Promise<Result> => {
      const step = steps[index];
      if (!step) return await handler();
      let active = true;
      let called = false;
      let pending: Promise<Result> | undefined;
      let settled = false;
      const next = (): Promise<Result> => {
        if (!active) return Promise.reject(new ExecutionPipelineError(
          "Execution continuation is closed", "EXECUTION_CONTINUATION_CLOSED",
        ));
        if (called) return Promise.reject(new ExecutionPipelineError(
          "Execution continuation called multiple times", "EXECUTION_CONTINUATION_REUSED",
        ));
        called = true;
        pending = dispatch(index + 1);
        // Observe immediately so an incorrectly detached rejection cannot become
        // unhandled. Recovery by a middleware that awaits/catches next is valid.
        void pending.then(() => { settled = true; }, () => { settled = true; });
        return pending;
      };
      try {
        const result = await step(context, next);
        if (pending && !settled) throw new ExecutionPipelineError(
          "Execution middleware must return or await next()", "EXECUTION_CONTINUATION_UNAWAITED",
        );
        return result;
      } finally {
        active = false;
        // Do not release the outer scope while already-started work is running.
        // This is a lifetime guard, not cancellation or rollback of that work.
        if (pending) await pending.catch(() => {});
      }
    };
    return await dispatch(0);
  };
}

/** Compatible with compiler-emitted AspectContext and aspectPipeline slots. */
export function composeAspects(...aspects: Aspect[]): Aspect {
  return composeExecution(...aspects);
}

/** HTTP callers may carry a Request; jobs/Workflow callers do not need to fake one. */
export type CommandPipelineInvocation = Omit<CommandRuntimeInvocation, "request"> & {
  readonly request?: Request;
};

/** Structurally accepts the existing CommandRuntimeGovernance HTTP ports. */
export interface CommandPipelineGovernance<Invocation extends CommandPipelineInvocation = CommandPipelineInvocation> {
  readonly authorize: (invocation: Invocation) => void | Promise<void>;
  readonly idempotency?: ExecutionMiddleware<Invocation>;
  readonly transaction?: ExecutionMiddleware<Invocation>;
  readonly audit?: {
    succeeded(invocation: Invocation, result: unknown): void | Promise<void>;
    failed(invocation: Invocation, error: unknown): void | Promise<void>;
  };
  readonly rpc?: Readonly<Record<string, {
    readonly capabilities: CommandRuntimeCapabilities;
    readonly execute: ExecutionMiddleware<Invocation>;
  }>>;
}

function missingAdapter(name: string, adapter: "audit" | "transaction" | "idempotency"): never {
  throw new ExecutionPipelineError(
    `Command "${name}" requires a ${adapter} adapter`,
    `COMMAND_${adapter.toUpperCase()}_UNAVAILABLE`, 501,
  );
}

/**
 * authorization -> idempotency -> transaction -> success audit -> handler
 * (success audit unwinds after the handler, inside the transaction).
 *
 * Always authorize, including receipt replays. Required adapters fail closed.
 * The adapter owns durable storage and atomicity; this function never retries,
 * infers project identity from headers, or claims a database rollback can undo
 * an external effect. Put module/command aspects inside the supplied handler.
 */
export function createCommandPipeline<Invocation extends CommandPipelineInvocation = CommandPipelineInvocation>(
  governance: CommandPipelineGovernance<Invocation>,
  observer?: ExecutionObserver,
): ExecutionMiddleware<Invocation> {
  if (!governance || typeof governance.authorize !== "function") {
    throw new ExecutionPipelineError(
      "Command authorization adapter is required", "COMMAND_AUTHORIZATION_UNCONFIGURED",
    );
  }
  return async (invocation, handler) => {
    const { command } = invocation;
    for (const mode of [command.transaction, command.idempotency]) {
      if (mode !== undefined && mode !== "required" && mode !== "none") {
        throw new ExecutionPipelineError("Invalid command governance mode", "COMMAND_MODE_INVALID");
      }
    }
    const observe = <Result>(stage: string, run: ExecutionNext<Result>) =>
      observeExecution(observer, {
        kind: "command", operation: command.name, stage,
        ...executionTrace(invocation.requestContext),
      }, run);
    const stage = (name: string, middleware: ExecutionMiddleware<Invocation>): ExecutionMiddleware<Invocation> =>
      (context, next) => observe(name, () => middleware.call(governance, context, next));

    if (command.rpc !== undefined) {
      const adapter = Object.hasOwn(governance.rpc ?? {}, command.rpc)
        ? governance.rpc?.[command.rpc] : undefined;
      if (!adapter || typeof adapter.execute !== "function" || !adapter.capabilities) {
        throw new ExecutionPipelineError("RPC governance adapter unavailable", "COMMAND_RPC_UNAVAILABLE", 501);
      }
      for (const capability of ["audit", "transaction", "idempotency"] as const) {
        const required = capability === "audit" ? !!command.audit : command[capability] === "required";
        if (required && adapter.capabilities[capability] !== true) missingAdapter(command.name, capability);
      }
      await observe("authorize", () => governance.authorize(invocation));
      return await composeExecution<Invocation>(
        (context, next) => observe(`rpc:${command.rpc}`, () => adapter.execute(context, next)),
      )(invocation, handler);
    }

    const audit = command.audit ? governance.audit : undefined;
    const transaction = command.transaction === "required" ? governance.transaction : undefined;
    const idempotency = command.idempotency === "required" ? governance.idempotency : undefined;
    if (command.audit && (!audit || typeof audit.succeeded !== "function" || typeof audit.failed !== "function")) {
      missingAdapter(command.name, "audit");
    }
    if (command.transaction === "required" && typeof transaction !== "function") missingAdapter(command.name, "transaction");
    if (command.idempotency === "required" && typeof idempotency !== "function") missingAdapter(command.name, "idempotency");

    const stages: ExecutionMiddleware<Invocation>[] = [];
    if (idempotency) stages.push(stage("idempotency", idempotency));
    if (transaction) stages.push(stage("transaction", transaction));
    stages.push(async (_context, next) => {
      const result = await observe("handler", next);
      if (audit) await observe("audit", () => audit.succeeded(invocation, result));
      return result;
    });
    try {
      // Authorization encloses even short-circuiting aspects and cached receipts.
      await observe("authorize", () => governance.authorize(invocation));
      return await composeExecution(...stages)(invocation, handler);
    } catch (error) {
      if (audit) {
        try {
          await observe("audit.failed", () => audit.failed(invocation, error));
        } catch (auditError) {
          // Preserve both failures. Never disguise a business failure as an
          // ordinary retryable audit error or silently lose a required audit.
          throw new AggregateError([error, auditError], "Command and failure audit both failed", { cause: error });
        }
      }
      throw error;
    }
  };
}
