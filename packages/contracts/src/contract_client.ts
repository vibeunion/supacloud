import { decodeHttpContract, type ContractDecoder } from "./http_contract.js";

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
    send(input: Input): Promise<unknown>;
    lookup?(input: Input): Promise<unknown>;
    matches(input: Input, result: Result): boolean;
    /** Application-classified definitive denial; never classify timeouts as definitive. */
    isDefinitiveFailure?(error: unknown): boolean;
  },
) {
  return async (value: Input): Promise<CommandOutcome<Result>> => {
    const input = decodeHttpContract(contract.input, value, "request");
    const decode = (value: unknown) => {
      const result = decodeHttpContract(contract.result, value, "response");
      if (transport.matches(input, result) !== true) throw new Error("Command receipt does not match");
      return result;
    };
    let response: { value: unknown } | undefined;
    try {
      response = { value: await transport.send(input) };
    } catch (error) {
      if (transport.isDefinitiveFailure?.(error) === true) throw error;
      // No exception details cross this boundary: transport errors can contain secrets.
    }
    if (response !== undefined) {
      try {
        return { status: "confirmed", result: decode(response.value), source: "response" };
      } catch {}
    }
    if (transport.lookup) {
      try {
        return { status: "confirmed", result: decode(await transport.lookup(input)), source: "lookup" };
      } catch {}
    }
    return { status: "unknown" };
  };
}
