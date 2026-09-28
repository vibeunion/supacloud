import { CommandError, canonicalCommandJson, commandIdentifier, decodeDurableCommandReceipt, type CommandIdentity } from "@supacloud/contracts";
import { checkAuthorization, commandContext, type PersistentCommandDefinition, type RecoveryPrincipal } from "./context";
import type { CommandStore, OperationReference } from "./store";

export interface ExternalDispatch { idempotencyKey: string; signal?: AbortSignal }
type TransactionOf<Store extends CommandStore<unknown>> = Store extends CommandStore<infer Transaction> ? Transaction : never;
type ExternalCommandDefinition<Input, Result, Store extends CommandStore<unknown>> =
  Omit<PersistentCommandDefinition<Input, Result, TransactionOf<Store>>, "store"> & {
    store: Store;
    send(input: Input, dispatch: ExternalDispatch): Promise<unknown>;
    lookup(input: Input, dispatch: ExternalDispatch): Promise<unknown>;
    matches(input: Input, result: Result): boolean;
    rejection?: {
      isDefinitiveWriteFailure(error: unknown): boolean;
      audit: {
        event: string;
        details(input: Input): unknown;
        write?(transaction: TransactionOf<Store>, input: Input): Promise<void>;
      };
    };
  };

export function createExternalCommand<Input, Result, Store extends CommandStore<unknown>>(
  definition: ExternalCommandDefinition<Input, Result, Store>,
) {
  const context = commandContext(definition as PersistentCommandDefinition<Input, Result, TransactionOf<Store>>);
  const rejection = definition.rejection;
  if (rejection !== undefined) commandIdentifier(rejection.audit.event);
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
    if (before.status === "rejected") return before;
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
      const current = await context.find(session, request, "external");
      if (current === null || current.status === "confirmed" || current.status === "rejected") return current;
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
    async execute(identity: CommandIdentity, key: string, value: unknown, signal?: AbortSignal) {
      if (signal?.aborted) throw new CommandError("COMMAND_UNAVAILABLE");
      const request = await context.prepare(identity, key, value);
      const acquired = await context.transaction(async (session) => {
        await context.lock(session, request);
        const existing = await context.find(session, request, "external");
        if (existing !== null) return { fresh: false, receipt: existing };
        if (rejection !== undefined && typeof session.reject !== "function") {
          throw new CommandError("COMMAND_UNAVAILABLE");
        }
        await context.insert(session, request, "external");
        const receipt = await context.find(session, request, "external");
        if (receipt === null) throw new CommandError("COMMAND_RECEIPT_INVALID");
        return { fresh: true, receipt };
      });
      if (!acquired.fresh) return acquired.receipt;
      try { await definition.send(request.input, {
        idempotencyKey: acquired.receipt.dispatchKey,
        ...(signal === undefined ? {} : { signal }),
      }); }
      catch (error) {
        let definitive = false;
        try { definitive = rejection?.isDefinitiveWriteFailure(error) === true; }
        catch { /* Classifier failures cannot establish a remote rejection. */ }
        if (definitive && rejection !== undefined) {
          try {
            return await context.transaction(async (session) => {
              await context.lock(session, request);
              const current = await context.find(session, request, "external");
              if (current === null) throw new CommandError("COMMAND_RECEIPT_INVALID");
              if (current.status === "confirmed" || current.status === "rejected") return current;
              if (typeof session.reject !== "function") throw new CommandError("COMMAND_UNAVAILABLE");
              const details: unknown = JSON.parse(canonicalCommandJson(rejection.audit.details(request.input)));
              await rejection.audit.write?.(session.transaction, request.input);
              await session.audit(request.reference, rejection.audit.event, details);
              await session.reject(request.reference);
              const rejected = await context.find(session, request, "external");
              if (rejected?.status !== "rejected") throw new CommandError("COMMAND_RECEIPT_INVALID");
              return rejected;
            });
          } catch { throw new CommandError("COMMAND_OUTCOME_UNKNOWN"); }
        }
      }
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
      const completed = await context.transaction(async (session) => {
        await session.lock(reference);
        const authorize = definition.authorizeRecovery;
        if (!authorize) throw new CommandError("COMMAND_REJECTED");
        await checkAuthorization(() => authorize(principal, reference, session.transaction));
        const stored = await session.read(reference);
        if (stored === null || stored.receipt.audit !== "complete"
          || (stored.receipt.status !== "confirmed" && stored.receipt.status !== "rejected")) return null;
        if (stored.kind !== "external") throw new CommandError("COMMAND_RECEIPT_INVALID");
        const receipt = decodeDurableCommandReceipt(stored.receipt, definition.result);
        for (const field of ["tenantId", "actorId", "command", "operationId"] as const) {
          if (receipt[field] !== reference[field]) throw new CommandError("COMMAND_RECEIPT_INVALID");
        }
        return receipt;
      });
      if (completed !== null) return completed;
      const request = await context.restore(reference, reference.operationId, principal);
      return request === null ? null : reconcile(reference, reference.operationId, request.input, principal);
    },
  };
}
