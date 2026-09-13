export type ContractDecoder<T> = (value: unknown) => T;

export interface HttpContract<Input, Result> {
  input: ContractDecoder<Input>;
  result: ContractDecoder<Result>;
  request: (input: Input) => {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    url: string;
    body?: unknown;
  };
}

export class HttpContractError extends Error {
  readonly code = "HTTP_CONTRACT_INVALID";

  constructor(readonly boundary: "request" | "response") {
    // Decoder errors may contain submitted credentials or response data.
    super(`HTTP ${boundary} contract invalid`);
    this.name = "HttpContractError";
  }
}

export function decodeHttpContract<T>(
  decode: ContractDecoder<T>,
  value: unknown,
  boundary: "request" | "response",
): T {
  try {
    return decode(value);
  } catch {
    throw new HttpContractError(boundary);
  }
}
