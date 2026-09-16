import { CommandError, canonicalCommandJson, type CommandIdentity, type DurableCommandReceipt } from "@supacloud/contracts";
import { commandContext, type PersistentCommandDefinition } from "./context";
import type { CommandStore } from "./store";
import { createExecutionPolicy, ExecutionPolicyError, type ExecutionPolicyOptions } from "./execution-policy";

type TransactionOf<Store extends CommandStore<unknown>> = Store extends CommandStore<infer Transaction> ? Transaction : never;
type TransactionalCommandDefinition<Input, Result, Store extends CommandStore<unknown>> =
  Omit<PersistentCommandDefinition<Input, Result, TransactionOf<Store>>, "store"> & {
    executionPolicy?: Omit<ExecutionPolicyOptions, "kind">;
    store: Store;
    execute(transaction: TransactionOf<Store>, input: Input, identity: CommandIdentity, signal: AbortSignal): Promise<unknown>;
  };

export function createTransactionalCommand<Input, Result, Store extends CommandStore<unknown>>(
  definition: TransactionalCommandDefinition<Input, Result, Store>,
) {
  const context = commandContext(definition as PersistentCommandDefinition<Input, Result, TransactionOf<Store>>);
  const policy = createExecutionPolicy({ ...definition.executionPolicy, kind: "command" });
  return {
    kind: "transactional" as const,
    async execute(identity: CommandIdentity, key: string, value: unknown, signal?: AbortSignal): Promise<DurableCommandReceipt<Result>> {
      const request = await context.prepare(identity, key, value);
      return policy.execute((signal) => context.transaction(async (session) => {
          if (signal.aborted) throw new CommandError("COMMAND_OUTCOME_UNKNOWN");
          await context.lock(session, request);
          const existing = await context.find(session, request, "transactional");
          if (existing !== null) return existing;
          const raw: unknown = JSON.parse(canonicalCommandJson(await definition.execute(session.transaction, request.input, request.reference, signal)));
          const result = definition.result(raw);
          if (signal.aborted) throw new CommandError("COMMAND_OUTCOME_UNKNOWN");
          await context.insert(session, request, "transactional", { result: raw });
          await context.audit(session, request, result);
          if (signal.aborted) throw new CommandError("COMMAND_OUTCOME_UNKNOWN");
          const receipt = await context.find(session, request, "transactional");
          if (receipt === null) throw new CommandError("COMMAND_RECEIPT_INVALID");
          return receipt;
        }), signal).catch((error: unknown) => {
        if (error instanceof ExecutionPolicyError) {
          throw new CommandError(error.code === "COMMAND_OUTCOME_UNKNOWN" ? error.code : "COMMAND_UNAVAILABLE");
        }
        throw error;
      });
    },
    async lookup(identity: CommandIdentity, key: string, value: unknown) {
      const request = await context.prepare(identity, key, value);
      return context.transaction(async (session) => {
        await context.lock(session, request);
        return context.find(session, request, "transactional");
      });
    },
    async lookupByReference(identity: CommandIdentity, key: string) {
      const request = await context.restore(identity, key);
      if (request === null) return null;
      return context.transaction(async (session) => {
        await context.lock(session, request);
        return context.find(session, request, "transactional");
      });
    },
  };
}
