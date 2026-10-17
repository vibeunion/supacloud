import { decodeHttpContract, type ContractDecoder } from "./http_contract.js";
import { decodeErrorMetadata } from "./app_error.js";

export { createAuthoritativeCommandClient } from "./authoritative_command.js";
export type {
  AuthoritativeCommandContract,
  AuthoritativeCommandOutcome,
  AuthoritativeCommandTransport,
  CommandAcknowledgement,
  CommandDiagnostic,
} from "./authoritative_command.js";

export interface CommandContract<Input, Result> {
  input: ContractDecoder<Input>;
  result: ContractDecoder<Result>;
}

export type CommandOutcome<Result> =
  | { status: "confirmed"; result: Result; source: "response" | "lookup" }
  | { status: "unknown" };

/**
 * One write attempt, then at most one read-only confirmation. Domain code owns
 * receipt decoding and request/entity matching. Unknown never authorizes retry.
 */
export function createContractCommandClient<Input, Result>(
  contract: CommandContract<Input, Result>,
  transport: {
    send(input: Input, signal?: AbortSignal): Promise<unknown>;
    lookup?(input: Input, signal?: AbortSignal): Promise<unknown>;
    matches(input: Input, result: Result): boolean;
    /** Decoded protocol metadata takes precedence over the legacy application classifier. */
    failureMetadata?(error: unknown): unknown;
    /** Application-classified definitive denial; never classify timeouts as definitive. */
    isDefinitiveFailure?(error: unknown): boolean;
  },
  options: { timeoutMs?: number } = {},
) {
  if (options.timeoutMs !== undefined
    && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647)) {
    throw new TypeError("Invalid command deadline");
  }
  const timeoutMs = options.timeoutMs;
  return async (value: Input): Promise<CommandOutcome<Result>> => {
    const input = decodeHttpContract(contract.input, value, "request");
    const controller = new AbortController();
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs);
    const signal = controller.signal;
    const bounded = async (operation: () => Promise<unknown>): Promise<unknown> => {
      signal.throwIfAborted();
      let onAbort: () => void = () => {};
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("Command deadline elapsed"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try { return await Promise.race([operation(), cancelled]); }
      finally { signal.removeEventListener("abort", onAbort); }
    };
    const decode = (value: unknown) => {
      const result = decodeHttpContract(contract.result, value, "response");
      if (transport.matches(input, result) !== true) throw new Error("Command receipt does not match");
      return result;
    };
    try {
      let response: { value: unknown } | undefined;
      try {
        response = { value: await bounded(() => transport.send(input, signal)) };
      } catch (error) {
        let definitive = false;
        try {
          const raw = transport.failureMetadata?.(error);
          const metadata = decodeErrorMetadata(raw);
          definitive = raw !== undefined
            ? metadata?.outcome === "confirmed-failure" && metadata.retryability === "never"
            : transport.isDefinitiveFailure?.(error) === true;
        } catch {
          // Classifier failure cannot prove that the write was rejected.
        }
        if (!signal.aborted && definitive) throw error;
      }
      if (response !== undefined) {
        try { return { status: "confirmed", result: decode(response.value), source: "response" }; }
        catch {}
      }
      if (transport.lookup && !signal.aborted) {
        try {
          const lookup = transport.lookup.bind(transport);
          return { status: "confirmed", result: decode(await bounded(() => lookup(input, signal))), source: "lookup" };
        } catch {}
      }
      return { status: "unknown" };
    } finally {
      clearTimeout(timer);
    }
  };
}
