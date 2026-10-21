import {
  createAuthoritativeCommandClient,
  type AuthoritativeCommandContract,
  type AuthoritativeCommandTransport,
} from "./authoritative_command.js";
import { decodeHttpContract } from "./http_contract.js";
import type { CommandLockStorage } from "./durable_locks.js";
import { canonicalCommandJson } from "./receipts.js";

export interface PendingCommandOptions<Input> {
  storage: CommandLockStorage;
  /** Caller-owned tenant/actor/target namespace; retains the existing JSON format. */
  key: string;
  /** Default is lookup, even after a valid acknowledgement. */
  confirmation?: "lookup" | "response";
  unknownError(input: Input, lookupFailure?: unknown): Error;
}

export interface PendingCommandRecoveryOptions<Input> extends Pick<PendingCommandOptions<Input>, "key" | "unknownError"> {
  storage: Pick<CommandLockStorage, "getItem" | "removeItem">;
}

function clearPendingCommand(
  storage: Pick<CommandLockStorage, "getItem" | "removeItem">,
  key: string,
  serialized: string,
): void {
  // Do not erase a newer operation placed in this slot while a request was pending.
  if (storage.getItem(key) === serialized) {
    storage.removeItem(key);
    if (storage.getItem(key) === serialized) throw new Error("Pending command was not cleared");
  }
}

/**
 * Recovers the stored request with one read and no send capability.
 * Null means no marker exists, not that a command was rolled back or confirmed.
 */
export function createPendingCommandRecovery<Input, Authority>(
  contract: Pick<AuthoritativeCommandContract<Input, unknown, Authority>, "input" | "authority" | "lookupAuthority" | "matches">,
  transport: Pick<AuthoritativeCommandTransport<Input>, "lookup">,
  options: PendingCommandRecoveryOptions<Input>,
): () => Promise<{ input: Input; authority: Authority } | null> {
  const { storage, key, unknownError } = options;
  const lookupAuthority = contract.lookupAuthority;
  if (!key.trim()) throw new TypeError("Invalid pending command configuration");
  return async () => {
    const serialized = storage.getItem(key);
    if (serialized === null) return null;
    const parsed: unknown = JSON.parse(serialized);
    const persisted = canonicalCommandJson(parsed);
    const readback = decodeHttpContract(contract.input, parsed, "request");
    if (canonicalCommandJson(readback) !== persisted) {
      throw new TypeError("Pending command input changes after serialization");
    }
    const input = structuredClone(readback);
    let raw: unknown;
    // Keep the stored identity stable even if a transport mutates its argument.
    try { raw = await transport.lookup(structuredClone(input)); }
    catch (cause) { throw unknownError(input, cause); }
    let authority: Authority;
    let matched: boolean;
    try {
      authority = decodeHttpContract(
        lookupAuthority === undefined
          ? contract.authority
          : (value) => lookupAuthority(value, structuredClone(input)),
        raw,
        "response",
      );
      matched = contract.matches(structuredClone(input), authority) === true;
    } catch {
      throw unknownError(input);
    }
    if (!matched) throw unknownError(input);
    clearPendingCommand(storage, key, serialized);
    return { input, authority };
  };
}

/**
 * Persists request identity before one write, then confirms without resending.
 * This is a pending marker, not a cross-tab lock or a server receipt store.
 */
export function createPendingCommandClient<Input, Acknowledgement, Authority>(
  contract: AuthoritativeCommandContract<Input, Acknowledgement, Authority>,
  transport: AuthoritativeCommandTransport<Input>,
  options: PendingCommandOptions<Input>,
): (value: Input) => Promise<Authority> {
  const { storage, key, unknownError } = options;
  const confirmation = options.confirmation ?? "lookup";
  if (!key.trim() || (confirmation !== "lookup" && confirmation !== "response")) {
    throw new TypeError("Invalid pending command configuration");
  }
  return async (value) => {
    const existing = storage.getItem(key);
    if (existing !== null) {
      const pending = decodeHttpContract(contract.input, JSON.parse(existing), "request");
      throw unknownError(pending);
    }
    const decoded = decodeHttpContract(contract.input, value, "request");
    const serialized = JSON.stringify(decoded);
    if (serialized === undefined) throw new TypeError("Pending command is not serializable");
    // Execute exactly the identity that survives a reload, never an unpersisted value.
    const readback = decodeHttpContract(contract.input, JSON.parse(serialized), "request");
    // A decoder must not change the durable identity or business values on readback.
    if (JSON.stringify(readback) !== serialized) {
      throw new TypeError("Pending command input changes after serialization");
    }
    // Detach decoder aliases and fail before persistence if the snapshot cannot be copied.
    const input = structuredClone(readback);
    storage.setItem(key, serialized);
    if (storage.getItem(key) !== serialized) throw new Error("Pending command was not persisted");
    let writeFailure: unknown;
    let lookupFailure: unknown;
    const execute = createAuthoritativeCommandClient({
      ...contract, input: () => input,
      matches: (request, authority) => contract.matches(structuredClone(request), authority),
    }, {
      send: async (request) => {
        try { return await transport.send(structuredClone(request)); }
        catch (cause) { writeFailure = cause; throw cause; }
      },
      lookup: async (request) => {
        try { return await transport.lookup(structuredClone(request)); }
        catch (cause) { lookupFailure = cause; throw cause; }
      },
      ...(transport.isDefinitiveWriteFailure === undefined ? {} : {
        isDefinitiveWriteFailure: (cause: unknown) => transport.isDefinitiveWriteFailure!(cause),
      }),
    }, { confirmation });
    const outcome = await execute(input);
    if (outcome.status === "confirmed") {
      clearPendingCommand(storage, key, serialized);
      return outcome.authority;
    }
    if (outcome.status === "denied") {
      clearPendingCommand(storage, key, serialized);
      throw writeFailure;
    }
    throw unknownError(input, lookupFailure);
  };
}
