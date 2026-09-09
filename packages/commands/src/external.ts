import { CommandError, canonicalCommandJson, type CommandIdentity } from "@supacloud/contracts";
import { commandContext, type PersistentCommandDefinition, type RecoveryPrincipal } from "./context";
import type { OperationReference } from "./store";

export interface ExternalDispatch { idempotencyKey: string }
export function createExternalCommand<Input, Result, Transaction>(
  definition: PersistentCommandDefinition<Input, Result, Transaction> & {
    send(input: Input, dispatch: ExternalDispatch): Promise<unknown>;
    lookup(input: Input, dispatch: ExternalDispatch): Promise<unknown>;
    matches(input: Input, result: Result): boolean;
  },
) {
  const context = commandContext(definition);
  const read = async (identity: CommandIdentity, key: string, value: unknown, principal?: RecoveryPrincipal) => {
    const request = await context.prepare(identity, key, value);
    return context.transaction(async (session) => {
      await context.lock(session, request, principal);
      return context.find(session, request, "external");
    });
  };
  const flushAudit = async (identity: CommandIdentity, key: string, value: unknown, principal?: RecoveryPrincipal) => {
    const request = await context.prepare(identity, key, value);
    return context.transaction(async (session) => {
      await context.lock(session, request, principal);
      const receipt = await context.find(session, request, "external");
      if (receipt === null || receipt.status !== "confirmed" || receipt.audit === "complete") return receipt;
      await context.audit(session, request, receipt.result);
      await session.completeAudit(request.reference);
      return context.find(session, request, "external");
    });
  };
  const reconcile = async (identity: CommandIdentity, key: string, value: unknown, principal?: RecoveryPrincipal) => {
    const request = await context.prepare(identity, key, value);
    const before = await read(identity, key, value, principal);
    if (before === null) return null;
    let confirmation: { raw: unknown } | undefined;
    if (before.status !== "confirmed") {
      try {
        const raw: unknown = JSON.parse(canonicalCommandJson(
          await definition.lookup(request.input, { idempotencyKey: before.dispatchKey }),
        ));
        if (definition.matches(request.input, definition.result(raw)) === true) confirmation = { raw };
      } catch { /* An unavailable or negative lookup never authorizes another send. */ }
    }
    const receipt = await context.transaction(async (session) => {
      await context.lock(session, request, principal);
      if (confirmation !== undefined) await session.confirm(request.reference, confirmation.raw);
      else if (before.status !== "confirmed") await session.markUnknown(request.reference);
      return context.find(session, request, "external");
    });
    if (receipt?.status !== "confirmed" || receipt.audit === "complete") return receipt;
    try { return await flushAudit(identity, key, value, principal); }
    catch (error) {
      if (error instanceof CommandError && error.code === "COMMAND_REJECTED") throw error;
      return receipt;
    }
  };
  return {
    kind: "external" as const,
    async execute(identity: CommandIdentity, key: string, value: unknown) {
      const request = await context.prepare(identity, key, value);
      const acquired = await context.transaction(async (session) => {
        await context.lock(session, request);
        const existing = await context.find(session, request, "external");
        if (existing !== null) return { fresh: false, receipt: existing };
        await context.insert(session, request, "external");
        const receipt = await context.find(session, request, "external");
        if (receipt === null) throw new CommandError("COMMAND_RECEIPT_INVALID");
        return { fresh: true, receipt };
      });
      if (!acquired.fresh) return acquired.receipt;
      try { await definition.send(request.input, { idempotencyKey: acquired.receipt.dispatchKey }); }
      catch { /* Intent is durable; transport errors cannot establish rollback. */ }
      try {
        const receipt = await reconcile(identity, key, request.input);
        if (receipt === null) throw new Error("Missing receipt");
        return receipt;
      } catch { throw new CommandError("COMMAND_OUTCOME_UNKNOWN"); }
    },
    lookup: read, reconcile, flushAudit,
    async lookupByReference(identity: CommandIdentity, key: string) {
      const request = await context.restore(identity, key);
      return request === null ? null : read(identity, key, request.input);
    },
    async reconcileByReference(identity: CommandIdentity, key: string) {
      const request = await context.restore(identity, key);
      return request === null ? null : reconcile(identity, key, request.input);
    },
    async flushAuditByReference(identity: CommandIdentity, key: string) {
      const request = await context.restore(identity, key);
      return request === null ? null : flushAudit(identity, key, request.input);
    },
    async recover(principal: RecoveryPrincipal, reference: OperationReference) {
      if (reference.command !== definition.name) throw new CommandError("COMMAND_REJECTED");
      const request = await context.restore(reference, reference.operationId, principal);
      return request === null ? null : reconcile(reference, reference.operationId, request.input, principal);
    },
  };
}
