import {
  createPendingCommandClient,
  createPendingCommandRecovery,
  type PendingCommandOptions,
  type PendingCommandRecoveryOptions,
} from "./pending_command.js";
import type {
  AuthoritativeCommandContract,
  AuthoritativeCommandTransport,
} from "./authoritative_command.js";
import type { CommandLockStorage } from "./durable_locks.js";

export interface FeatureSliceCommandClient<Input, Authority> {
  execute(value: Input): Promise<Authority>;
  recover(): Promise<{ input: Input; authority: Authority } | null>;
  readonly invalidateTags: readonly string[];
}

export interface FeatureSliceCommandClientOptions<Input>
  extends PendingCommandOptions<Input> {
  /** Explicit cache tags declared by the Feature transition. */
  invalidateTags?: readonly string[];
}

export interface FeatureSliceRecoveryOptions<Input>
  extends PendingCommandRecoveryOptions<Input> {
  /** Explicit cache tags declared by the Feature transition. */
  invalidateTags?: readonly string[];
}

/**
 * The standard browser/client entrypoint for a generated Feature Slice.
 *
 * It composes the existing durable pending marker and read-only recovery
 * primitives. It does not create a receipt store, retry a write, or infer
 * invalidation tags from a route name.
 */
export function createFeatureSliceCommandClient<Input, Acknowledgement, Authority>(
  contract: AuthoritativeCommandContract<Input, Acknowledgement, Authority>,
  transport: AuthoritativeCommandTransport<Input>,
  options: FeatureSliceCommandClientOptions<Input>,
): FeatureSliceCommandClient<Input, Authority> {
  const recoveryOptions: FeatureSliceRecoveryOptions<Input> = {
    storage: options.storage as Pick<CommandLockStorage, "getItem" | "removeItem">,
    key: options.key,
    unknownError: options.unknownError,
    ...(options.invalidateTags === undefined ? {} : { invalidateTags: options.invalidateTags }),
  };
  const invalidateTags = Object.freeze([...(options.invalidateTags ?? [])]);
  const execute = createPendingCommandClient(contract, transport, options);
  const recover = createPendingCommandRecovery(contract, { lookup: transport.lookup }, recoveryOptions);
  return Object.freeze({ execute, recover, invalidateTags });
}
