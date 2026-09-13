import { decodeHttpContract, type ContractDecoder } from "./http_contract.js";

export interface AuthoritativeCommandContract<Input, Acknowledgement, Authority> {
  input: ContractDecoder<Input>;
  acknowledgement: ContractDecoder<Acknowledgement>;
  authority: ContractDecoder<Authority>;
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
  return async (value) => {
    const diagnostics: CommandDiagnostic[] = [];
    let input: Input;
    try {
      input = decodeHttpContract(contract.input, value, "request");
    } catch {
      return { status: "invalid", diagnostics: [{ stage: "input", code: "INVALID_INPUT" }] };
    }

    let acknowledgement: CommandAcknowledgement<Acknowledgement> = { status: "unavailable" };
    let response: { value: unknown } | undefined;
    try {
      response = { value: await transport.send(input) };
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

    const confirm = (raw: unknown): { authority: Authority } | undefined => {
      let authority: Authority;
      try {
        authority = decodeHttpContract(contract.authority, raw, "response");
      } catch {
        diagnostics.push({ stage: "authority", code: "INVALID_AUTHORITY" });
        return undefined;
      }
      try {
        if (contract.matches(input, authority) === true) return { authority };
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
        const result = confirm(response.value);
        if (result !== undefined) {
          return { status: "confirmed", ...result, acknowledgement, source: "response", diagnostics };
        }
      }
    }

    // Both successful and failed sends converge here; a failed read has no retry path.
    let rawAuthority: unknown;
    try {
      rawAuthority = await transport.lookup(input);
    } catch {
      diagnostics.push({ stage: "lookup", code: "LOOKUP_FAILED" });
      return { status: "unknown", acknowledgement, diagnostics };
    }
    const result = confirm(rawAuthority);
    return result === undefined
      ? { status: "unknown", acknowledgement, diagnostics }
      : { status: "confirmed", ...result, acknowledgement, source: "lookup", diagnostics };
  };
}
