export type RpcDecoder<T> = (value: unknown) => T;

export interface RpcContract<Args extends Record<string, unknown>, Result> {
  args: RpcDecoder<Args>;
  result: RpcDecoder<Result>;
}

export type RpcArgs<Contract> = Contract extends RpcContract<infer Args, unknown> ? Args : never;
export type RpcResult<Contract> = Contract extends RpcContract<Record<string, unknown>, infer Result> ? Result : never;

export interface RpcTransport {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

export type RpcCallResult<T> =
  | { ok: true; data: T; error: null }
  | { ok: false; data: null; error: unknown };

export class RpcContractError extends Error {
  readonly code = 'RPC_CONTRACT_INVALID';

  constructor(readonly rpcName: string, readonly phase: 'registration' | 'args' | 'result') {
    // Do not expose arguments, response payloads or decoder errors in diagnostics.
    super(`RPC contract validation failed (${phase})`);
    this.name = 'RpcContractError';
  }
}

export function defineRpcContract<Args extends Record<string, unknown>, Result>(
  contract: RpcContract<Args, Result>,
): Readonly<RpcContract<Args, Result>> {
  return Object.freeze({ ...contract });
}

type Contracts = Record<string, RpcContract<Record<string, unknown>, unknown>>;

export function createRpcClient<const Registry extends Contracts>(
  transport: RpcTransport,
  contracts: Registry,
) {
  // Snapshot registrations so later mutations cannot replace a trusted decoder.
  const registered = new Map(Object.entries(contracts).map(([name, contract]) => [
    name, defineRpcContract(contract),
  ]));

  return {
    async call<Name extends Extract<keyof Registry, string>>(
      name: Name,
      args: RpcArgs<Registry[NoInfer<Name>]>,
    ): Promise<RpcCallResult<RpcResult<Registry[Name]>>> {
      const contract = registered.get(name);
      if (!contract) throw new RpcContractError(name, 'registration');
      let decodedArgs: Record<string, unknown>;
      try {
        decodedArgs = contract.args(args);
        if (!decodedArgs || typeof decodedArgs !== 'object' || Array.isArray(decodedArgs)) {
          throw new TypeError('RPC arguments must decode to an object');
        }
      } catch {
        throw new RpcContractError(name, 'args');
      }
      // One transport call only: a failed decode may follow a committed command.
      const response = await transport.rpc(name, decodedArgs);
      if (!response || typeof response !== 'object' || Array.isArray(response)
        || !Object.hasOwn(response, 'error')) {
        throw new RpcContractError(name, 'result');
      }
      if (response.error != null) return { ok: false, data: null, error: response.error };
      if (!Object.hasOwn(response, 'data')) throw new RpcContractError(name, 'result');
      try {
        // The registry index loses generic correlation; this cast follows decoding.
        const data = contract.result(response.data) as RpcResult<Registry[Name]>;
        return { ok: true, data, error: null };
      } catch {
        throw new RpcContractError(name, 'result');
      }
    },
  };
}
