/**
 * Framework-neutral command governance ports.
 *
 * The application package owns the contract; a server adapter owns the
 * durable receipt, transaction and audit implementation.
 */
export type CommandRuntimeMode = "required" | "none";

export interface CommandRuntimeDescriptor {
  readonly name: string;
  readonly permission?: string;
  readonly rpc?: string;
  readonly transaction?: CommandRuntimeMode | string;
  readonly audit?: string;
  readonly idempotency?: CommandRuntimeMode | string;
}

export interface CommandRuntimeInput {
  readonly body: unknown;
  readonly params: Record<string, unknown>;
  readonly query: Record<string, unknown>;
}

export interface CommandRuntimeInvocation<
  TCommand extends CommandRuntimeDescriptor = CommandRuntimeDescriptor,
> {
  readonly command: TCommand;
  readonly input: CommandRuntimeInput;
  readonly request: Request;
  readonly requestContext: unknown;
  readonly scope?: Record<string, unknown>;
  readonly services: Record<string, unknown>;
}

export type CommandRuntimeMiddleware<
  TInvocation extends CommandRuntimeInvocation = CommandRuntimeInvocation,
> = (
  invocation: TInvocation,
  next: () => unknown | Promise<unknown>,
) => unknown | Promise<unknown>;

export type CommandRuntimeAuthorizer<
  TInvocation extends CommandRuntimeInvocation = CommandRuntimeInvocation,
> = (invocation: TInvocation) => void | Promise<void>;

export interface CommandRuntimeAudit<
  TInvocation extends CommandRuntimeInvocation = CommandRuntimeInvocation,
> {
  succeeded(invocation: TInvocation, result: unknown): void | Promise<void>;
  failed(invocation: TInvocation, error: unknown): void | Promise<void>;
}

export interface CommandRuntimeCapabilities {
  readonly audit?: boolean;
  readonly transaction?: boolean;
  readonly idempotency?: boolean;
  readonly boundary?: "database" | "external";
}

export interface CommandRuntimeAdapter<
  TInvocation extends CommandRuntimeInvocation = CommandRuntimeInvocation,
> {
  readonly capabilities: CommandRuntimeCapabilities;
  readonly execute: CommandRuntimeMiddleware<TInvocation>;
}

export interface CommandRuntimeGovernance<
  TInvocation extends CommandRuntimeInvocation = CommandRuntimeInvocation,
> {
  readonly rpc?: Record<string, CommandRuntimeAdapter<TInvocation>>;
  readonly authorize: CommandRuntimeAuthorizer<TInvocation>;
  readonly idempotency?: CommandRuntimeMiddleware<TInvocation>;
  readonly transaction?: CommandRuntimeMiddleware<TInvocation>;
  readonly audit?: CommandRuntimeAudit<TInvocation>;
}
