import {
  CommandError, canonicalCommandJson, commandIdentifier, decodeCommandIdentity, decodeDurableCommandReceipt,
  type CommandAuthorization, type CommandIdentity, type ContractDecoder, type DurableCommandReceipt,
} from "@supacloud/contracts";
import type { CommandStore, CommandStoreSession, OperationReference, StoredCommand } from "./store";

export interface CommandInputCodec {
  encode(canonicalInput: string): string | Promise<string>;
  decode(payload: string): string | Promise<string>;
}
/** Explicit opt-in for non-secret inputs. Supply an authenticated encryption codec otherwise. */
export const plaintextCommandInput: CommandInputCodec = {
  encode: (value) => value, decode: (value) => value,
};
export interface RecoveryPrincipal { subject: string }
export interface PersistentCommandDefinition<Input, Result, Transaction> {
  store: CommandStore<Transaction>;
  name: string;
  input: ContractDecoder<Input>;
  result: ContractDecoder<Result>;
  inputCodec: CommandInputCodec;
  authorize(identity: CommandIdentity, input: Input, transaction: Transaction): CommandAuthorization | Promise<CommandAuthorization>;
  /** Independent worker authorization; never impersonate a revoked interactive session. */
  authorizeRecovery?(
    principal: RecoveryPrincipal, reference: OperationReference, transaction: Transaction,
  ): CommandAuthorization | Promise<CommandAuthorization>;
  audit: {
    event: string;
    details(input: Input, result: Result): unknown;
    write?(transaction: Transaction, input: Input, result: Result): Promise<void>;
  };
}
interface Prepared<Input> {
  reference: OperationReference;
  input: Input;
  fingerprint: string;
  payload: string;
}
async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function checkAuthorization(run: () => CommandAuthorization | Promise<CommandAuthorization>): Promise<void> {
  let decision: unknown;
  try { decision = await run(); }
  catch { throw new CommandError("COMMAND_UNAVAILABLE"); }
  if (decision === "deny") throw new CommandError("COMMAND_REJECTED");
  if (decision !== "allow") throw new CommandError("COMMAND_UNAVAILABLE");
}

export function commandContext<Input, Result, Transaction>(definition: PersistentCommandDefinition<Input, Result, Transaction>) {
  const name = commandIdentifier(definition.name), event = commandIdentifier(definition.audit.event);
  const reference = (identity: CommandIdentity, key: string): OperationReference => {
    try { return { ...decodeCommandIdentity(identity), command: name, operationId: commandIdentifier(key) }; }
    catch { throw new CommandError("COMMAND_INPUT_INVALID"); }
  };
  const prepare = async (identity: CommandIdentity, key: string, value: unknown): Promise<Prepared<Input>> => {
    const ref = reference(identity, key);
    let input: Input, canonical: string;
    try {
      canonical = canonicalCommandJson(definition.input(value));
      const json: unknown = JSON.parse(canonical);
      input = definition.input(json);
      if (canonicalCommandJson(input) !== canonical) throw new Error("Unstable input codec");
    } catch { throw new CommandError("COMMAND_INPUT_INVALID"); }
    let payload: unknown;
    try { payload = await definition.inputCodec.encode(canonical); }
    catch { throw new CommandError("COMMAND_UNAVAILABLE"); }
    if (typeof payload !== "string") throw new CommandError("COMMAND_UNAVAILABLE");
    return { reference: ref, input, fingerprint: await fingerprint(canonical), payload };
  };
  const authorize = async (
    session: CommandStoreSession<Transaction>, request: Prepared<Input>, principal?: RecoveryPrincipal,
  ) => {
    if (principal !== undefined) {
      commandIdentifier(principal.subject);
      const authorizeRecovery = definition.authorizeRecovery;
      if (!authorizeRecovery) throw new CommandError("COMMAND_REJECTED");
      await checkAuthorization(() => authorizeRecovery(principal, request.reference, session.transaction));
    } else {
      await checkAuthorization(() => definition.authorize(request.reference, request.input, session.transaction));
    }
  };
  const lock = async (session: CommandStoreSession<Transaction>, request: Prepared<Input>, principal?: RecoveryPrincipal) => {
    await session.lock(request.reference);
    await authorize(session, request, principal);
  };
  const find = async (
    session: CommandStoreSession<Transaction>, request: Prepared<Input>, kind: StoredCommand["kind"],
  ): Promise<DurableCommandReceipt<Result> | null> => {
    const stored = await session.read(request.reference);
    if (stored === null) return null;
    if (stored.inputFingerprint !== request.fingerprint || stored.kind !== kind) throw new CommandError("COMMAND_IDEMPOTENCY_CONFLICT");
    try {
      const receipt = decodeDurableCommandReceipt(stored.receipt, definition.result);
      for (const key of ["tenantId", "actorId", "command", "operationId"] as const) {
        if (receipt[key] !== request.reference[key]) throw new Error("Mismatched receipt");
      }
      if (kind === "transactional" && (receipt.status !== "confirmed" || receipt.audit !== "complete")) throw new Error("Invalid receipt state");
      return receipt;
    } catch { throw new CommandError("COMMAND_RECEIPT_INVALID"); }
  };
  const transaction = async <T>(run: (session: CommandStoreSession<Transaction>) => Promise<T>): Promise<T> => {
    try { return await definition.store.transaction(run); }
    catch (error) {
      if (error instanceof CommandError) throw error;
      throw new CommandError("COMMAND_OUTCOME_UNKNOWN");
    }
  };
  const restore = async (identity: CommandIdentity, key: string, principal?: RecoveryPrincipal) => {
    const ref = reference(identity, key);
    return transaction(async (session) => {
      await session.lock(ref);
      const stored = await session.read(ref);
      if (stored === null) return null;
      if (stored.inputPayload === null) throw new CommandError("COMMAND_INPUT_EXPIRED");
      let json: unknown;
      try {
        const decoded = await definition.inputCodec.decode(stored.inputPayload);
        if (typeof decoded !== "string") throw new Error("Invalid payload");
        json = JSON.parse(decoded);
      } catch { throw new CommandError("COMMAND_UNAVAILABLE"); }
      const request = await prepare(identity, key, json);
      if (request.fingerprint !== stored.inputFingerprint) throw new CommandError("COMMAND_RECEIPT_INVALID");
      await authorize(session, request, principal);
      return request;
    });
  };
  const audit = async (session: CommandStoreSession<Transaction>, request: Prepared<Input>, result: Result) => {
    const details: unknown = JSON.parse(canonicalCommandJson(definition.audit.details(request.input, result)));
    await definition.audit.write?.(session.transaction, request.input, result);
    await session.audit(request.reference, event, details);
  };
  const insert = async (
    session: CommandStoreSession<Transaction>, request: Prepared<Input>,
    kind: StoredCommand["kind"], raw?: { result: unknown },
  ) => {
    const reference = { ...request.reference, dispatchKey: crypto.randomUUID() };
    const receipt: DurableCommandReceipt<unknown> = raw === undefined
      ? { ...reference, status: "pending", audit: "pending" }
      : { ...reference, status: "confirmed", audit: "complete", result: raw.result };
    await session.insert({ receipt, kind, inputFingerprint: request.fingerprint, inputPayload: request.payload });
  };
  return { prepare, lock, find, restore, transaction, audit, insert };
}
