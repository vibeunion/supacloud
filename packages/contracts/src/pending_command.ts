import {
  createAuthoritativeCommandClient,
  type AuthoritativeCommandContract,
  type AuthoritativeCommandTransport,
} from "./authoritative_command.js";
import { decodeHttpContract } from "./http_contract.js";
import type { CommandLockStorage } from "./durable_locks.js";

export interface PendingCommandOptions<Input> {
  storage: CommandLockStorage;
  /** Caller-owned tenant/actor/target namespace; retains the existing JSON format. */
  key: string;
  /** Default is lookup, even after a valid acknowledgement. */
  confirmation?: "lookup" | "response";
  unknownError(input: Input, lookupFailure?: unknown): Error;
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
    const input = decodeHttpContract(contract.input, JSON.parse(serialized), "request");
    // A decoder must not change the durable identity or business values on readback.
    if (JSON.stringify(input) !== serialized) {
      throw new TypeError("Pending command input changes after serialization");
    }
    storage.setItem(key, serialized);
    if (storage.getItem(key) !== serialized) throw new Error("Pending command was not persisted");
    const release = () => {
      // Do not erase a newer operation placed in this slot while a request was pending.
      if (storage.getItem(key) === serialized) {
        storage.removeItem(key);
        if (storage.getItem(key) === serialized) throw new Error("Pending command was not cleared");
      }
    };
    let writeFailure: unknown;
    let lookupFailure: unknown;
    const execute = createAuthoritativeCommandClient({
      ...contract, input: () => input,
    }, {
      send: async (request) => {
        try { return await transport.send(request); }
        catch (cause) { writeFailure = cause; throw cause; }
      },
      lookup: async (request) => {
        try { return await transport.lookup(request); }
        catch (cause) { lookupFailure = cause; throw cause; }
      },
      ...(transport.isDefinitiveWriteFailure === undefined ? {} : {
        isDefinitiveWriteFailure: (cause: unknown) => transport.isDefinitiveWriteFailure!(cause),
      }),
    }, { confirmation });
    const outcome = await execute(input);
    if (outcome.status === "confirmed") {
      release();
      return outcome.authority;
    }
    if (outcome.status === "denied") {
      release();
      throw writeFailure;
    }
    throw unknownError(input, lookupFailure);
  };
}
