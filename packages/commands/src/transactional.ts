import { CommandError, canonicalCommandJson, type CommandIdentity, type DurableCommandReceipt } from "@supacloud/contracts";
import { commandContext, type PersistentCommandDefinition } from "./context";

export function createTransactionalCommand<Input, Result, Transaction>(
  definition: PersistentCommandDefinition<Input, Result, Transaction> & {
    execute(transaction: Transaction, input: Input, identity: CommandIdentity): Promise<unknown>;
  },
) {
  const context = commandContext(definition);
  return {
    kind: "transactional" as const,
    async execute(identity: CommandIdentity, key: string, value: unknown): Promise<DurableCommandReceipt<Result>> {
      const request = await context.prepare(identity, key, value);
      return context.transaction(async (session) => {
        await context.lock(session, request);
        const existing = await context.find(session, request, "transactional");
        if (existing !== null) return existing;
        const raw: unknown = JSON.parse(canonicalCommandJson(await definition.execute(session.transaction, request.input, request.reference)));
        const result = definition.result(raw);
        await context.insert(session, request, "transactional", { result: raw });
        await context.audit(session, request, result);
        const receipt = await context.find(session, request, "transactional");
        if (receipt === null) throw new CommandError("COMMAND_RECEIPT_INVALID");
        return receipt;
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
