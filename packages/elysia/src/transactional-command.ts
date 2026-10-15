import { AsyncLocalStorage } from "node:async_hooks";
import { createTransactionalCommand, type PersistentCommandDefinition } from "@supacloud/commands";
import {
  CommandError, commandFailureMetadata, decodeCommandIdentity, type CommandIdentity,
} from "@supacloud/contracts";
import { ApplicationError, requireIdempotencyKey, type CommandGovernance, type CommandInvocation } from "./index";
import { commandErrorCode, commandErrorStatus } from "./command-errors";

export interface TransactionalCommandGovernanceOptions<Input, Result, Transaction> {
  definition: PersistentCommandDefinition<Input, Result, Transaction>;
  permission: string;
  /** The host must verify identity and project ownership, never use body fields. */
  identity(invocation: CommandInvocation): CommandIdentity | Promise<CommandIdentity>;
  input(invocation: CommandInvocation): unknown;
  /** Translate only known domain rejections; unknown failures stay outcome-unknown. */
  rejection?(error: unknown): CommandError | undefined;
}

/**
 * Adapts a local compiled Command to the existing durable executor. The handler,
 * receipt and authoritative audit share one transaction; no second store exists.
 */
export function createTransactionalCommandGovernance<Input, Result, Transaction>(
  options: TransactionalCommandGovernanceOptions<Input, Result, Transaction>,
): { governance: CommandGovernance; transaction(): Transaction } {
  const { definition, permission, identity, input, rejection } = options;
  const { name, audit } = definition;
  if (!permission.trim()) throw new TypeError("Command permission is required");
  interface Call {
    invocation: CommandInvocation;
    next(): unknown | Promise<unknown>;
    transaction?: Transaction;
    active: boolean;
  }
  const calls = new AsyncLocalStorage<Call>();
  function current(invocation?: CommandInvocation): Call & { transaction: Transaction } {
    const call = calls.getStore();
    if (!call?.active || call.transaction === undefined
      || invocation !== undefined && call.invocation !== invocation) {
      throw new Error("Command transaction is not active for this invocation");
    }
    return { ...call, transaction: call.transaction };
  }
  function assertBinding(invocation: CommandInvocation): void {
    const command = invocation.command;
    if (command.name !== name || command.permission !== permission || command.audit !== audit.event
      || command.transaction !== "required" || command.idempotency !== "required" || command.rpc !== undefined) {
      throw new ApplicationError("Unsupported transactional command", { status: 501, code: "COMMAND_BINDING_MISMATCH" });
    }
  }
  const command = createTransactionalCommand({
    ...definition,
    async execute(transaction) {
      const call = calls.getStore();
      if (!call || call.active) throw new Error("Command continuation is not available");
      call.transaction = transaction;
      call.active = true;
      try { return await call.next(); }
      catch (error) { throw rejection?.(error) ?? error; }
      finally { call.active = false; call.transaction = undefined; }
    },
  });
  return {
    transaction: () => current().transaction,
    governance: {
      async authorize(invocation) {
        assertBinding(invocation);
        decodeCommandIdentity(await identity(invocation));
      },
      async idempotency(invocation, next) {
        assertBinding(invocation);
        try {
          const actor = decodeCommandIdentity(await identity(invocation));
          const key = requireIdempotencyKey(invocation);
          const value = input(invocation);
          const receipt = await calls.run({ invocation, next, active: false },
            () => command.execute(actor, key, value, invocation.request.signal));
          if (receipt.status !== "confirmed") throw new CommandError("COMMAND_OUTCOME_UNKNOWN");
          return receipt.result;
        } catch (error) {
          const code = commandErrorCode(error);
          if (!code) throw error;
          throw new ApplicationError(code, {
            code, status: commandErrorStatus(code), metadata: commandFailureMetadata(code),
          });
        }
      },
      transaction(invocation, next) { current(invocation); return next(); },
      // The durable executor writes the audit after validation, before commit.
      audit: { succeeded(invocation) { current(invocation); }, failed() {} },
    },
  };
}
