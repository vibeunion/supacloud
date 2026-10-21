import { decodeHttpContract, type ContractDecoder } from "./http_contract.js";

export interface AuthoritativeCommandContract<Input, Acknowledgement, Authority> {
  input: ContractDecoder<Input>;
  acknowledgement: ContractDecoder<Acknowledgement>;
  authority: ContractDecoder<Authority>;
  /** Optional receipt decoder with an isolated copy of the validated request. */
  lookupAuthority?(value: unknown, input: Input): Authority;
  /** Optional direct-response decoder when a committed response and a receipt differ. */
  responseAuthority?: ContractDecoder<Authority>;
  matches(input: Input, authority: Authority): boolean;
}

export type CommandDiagnostic =
  | { stage: "input"; code: "INVALID_INPUT" }
  | { stage: "write"; code: "WRITE_OUTCOME_UNKNOWN" | "WRITE_REJECTED" }
  | { stage: "classification"; code: "CLASSIFICATION_FAILED" }
  | { stage: "acknowledgement"; code: "INVALID_ACKNOWLEDGEMENT" }
  | { stage: "lookup"; code: "LOOKUP_FAILED" }
  | { stage: "authority"; code: "INVALID_AUTHORITY" | "AUTHORITY_MISMATCH" };

export type CommandAcknowledgement<T> =
  | { status: "unavailable" }
  | { status: "validated"; value: T };

export type AuthoritativeCommandOutcome<Acknowledgement, Authority> = (
  | { status: "invalid" }
  | { status: "denied" }
  | {
    status: "confirmed";
    authority: Authority;
    acknowledgement: CommandAcknowledgement<Acknowledgement>;
    source: "response" | "lookup";
  }
  | { status: "unknown"; acknowledgement: CommandAcknowledgement<Acknowledgement> }
) & { diagnostics: readonly CommandDiagnostic[] };

export interface AuthoritativeCommandTransport<Input> {
  send(input: Input): Promise<unknown>;
  lookup(input: Input): Promise<unknown>;
  /** Only a send rejection is classified. No HTTP status is definitive by default. */
  isDefinitiveWriteFailure?(error: unknown): boolean;
}

/**
 * Validates each external boundary separately. Lookup confirmation is the default,
 * including after a valid acknowledgement. One invocation never resends a write.
 */
export function createAuthoritativeCommandClient<Input, Acknowledgement, Authority>(
  contract: AuthoritativeCommandContract<Input, Acknowledgement, Authority>,
  transport: AuthoritativeCommandTransport<Input>,
  options: { confirmation: "lookup" | "response" } = { confirmation: "lookup" },
): (value: unknown) => Promise<AuthoritativeCommandOutcome<Acknowledgement, Authority>> {
  if (options.confirmation !== "lookup" && options.confirmation !== "response") {
    throw new TypeError("Invalid command confirmation mode");
  }
  const confirmation = options.confirmation;
  const lookupAuthority = contract.lookupAuthority;
  return async (value) => {
    const diagnostics: CommandDiagnostic[] = [];
    let input: Input;
    try {
      input = decodeHttpContract(contract.input, value, "request");
      // Contextual receipt decoding must not capture a transport's mutable input.
      if (lookupAuthority !== undefined) input = structuredClone(input);
    } catch {
      return { status: "invalid", diagnostics: [{ stage: "input", code: "INVALID_INPUT" }] };
    }
    const request = () => lookupAuthority === undefined ? input : structuredClone(input);

    let acknowledgement: CommandAcknowledgement<Acknowledgement> = { status: "unavailable" };
    let response: { value: unknown } | undefined;
    try {
      response = { value: await transport.send(request()) };
    } catch (error) {
      try {
        if (transport.isDefinitiveWriteFailure?.(error) === true) {
          return { status: "denied", diagnostics: [{ stage: "write", code: "WRITE_REJECTED" }] };
        }
      } catch {
        diagnostics.push({ stage: "classification", code: "CLASSIFICATION_FAILED" });
      }
      diagnostics.push({ stage: "write", code: "WRITE_OUTCOME_UNKNOWN" });
    }

    const confirm = (raw: unknown, decode = contract.authority): { authority: Authority } | undefined => {
      let authority: Authority;
      try {
        authority = decodeHttpContract(decode, raw, "response");
      } catch {
        diagnostics.push({ stage: "authority", code: "INVALID_AUTHORITY" });
        return undefined;
      }
      try {
        if (contract.matches(request(), authority) === true) return { authority };
      } catch {
        // Matchers may contain business data in their exceptions.
      }
      diagnostics.push({ stage: "authority", code: "AUTHORITY_MISMATCH" });
      return undefined;
    };

    if (response !== undefined) {
      try {
        acknowledgement = {
          status: "validated",
          value: decodeHttpContract(contract.acknowledgement, response.value, "response"),
        };
      } catch {
        diagnostics.push({ stage: "acknowledgement", code: "INVALID_ACKNOWLEDGEMENT" });
      }
      if (confirmation === "response" && acknowledgement.status === "validated") {
        const result = confirm(response.value, contract.responseAuthority ?? contract.authority);
        if (result !== undefined) {
          return { status: "confirmed", ...result, acknowledgement, source: "response", diagnostics };
        }
      }
    }

    // Both successful and failed sends converge here; a failed read has no retry path.
    let rawAuthority: unknown;
    try {
      rawAuthority = await transport.lookup(request());
    } catch {
      diagnostics.push({ stage: "lookup", code: "LOOKUP_FAILED" });
      return { status: "unknown", acknowledgement, diagnostics };
    }
    const result = confirm(rawAuthority, lookupAuthority === undefined
      ? contract.authority
      : (raw) => lookupAuthority(raw, request()));
    return result === undefined
      ? { status: "unknown", acknowledgement, diagnostics }
      : { status: "confirmed", ...result, acknowledgement, source: "lookup", diagnostics };
  };
}
