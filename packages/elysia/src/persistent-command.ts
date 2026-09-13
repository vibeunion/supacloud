import {
  CommandError, decodeCommandIdentity, type CommandIdentity, type DurableCommandReceipt,
} from "@supacloud/contracts";
import { ApplicationError, requireIdempotencyKey, type CommandInvocation } from "./index";
import { commandErrorStatus } from "./command-errors";

export interface PersistentCommandHandler<Result> {
  readonly kind: "transactional" | "external";
  execute(identity: CommandIdentity, key: string, value: unknown): Promise<DurableCommandReceipt<Result>>;
}

/** Registered persistence owns the operation; a second route handler is never invoked. */
export function createPersistentCommandAdapter<Result>(
  command: PersistentCommandHandler<Result>,
  options: {
    /** Resolve verified tenant/actor identity from the host, never from request body. */
    identity(invocation: CommandInvocation): CommandIdentity | Promise<CommandIdentity>;
    input(invocation: CommandInvocation): unknown;
  },
) {
  return {
    capabilities: {
      audit: true, idempotency: true, transaction: command.kind === "transactional",
      boundary: command.kind === "transactional" ? "database" as const : "external" as const,
    },
    async execute(invocation: CommandInvocation): Promise<DurableCommandReceipt<Result>> {
      try {
        const identity = decodeCommandIdentity(await options.identity(invocation));
        return await command.execute(identity, requireIdempotencyKey(invocation), options.input(invocation));
      } catch (error) {
        if (!(error instanceof CommandError)) throw error;
        const status = commandErrorStatus(error.code);
        throw new ApplicationError(error.code, { code: error.code, status });
      }
    },
  };
}
