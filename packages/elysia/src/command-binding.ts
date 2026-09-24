import type { CommandPreview } from "@supacloud/contracts";
import {
  executeCompiledCommand,
  previewCompiledCommand,
  type CommandGovernance,
  type CompiledModule,
  type ExecutionObserver,
} from "./index";

/** Supplied by the trusted host for each call, never captured as binding configuration. */
export interface CompiledCommandCallContext {
  request: Request;
  requestContext: unknown;
  services?: Record<string, unknown>;
  scope?: Record<string, unknown>;
}

export interface CompiledCommandBindingOptions<Input, Result> {
  module: Pick<CompiledModule, "name" | "commands" | "aspects" | "aspectPipeline">;
  /** Compiled command class name, as required by executeCompiledCommand. */
  command: string;
  governance: CommandGovernance;
  observer?: ExecutionObserver;
  handler(input: Input, context: CompiledCommandCallContext): Result | Promise<Result>;
  decode(value: unknown): Result;
  preview?(input: Input, context: CompiledCommandCallContext): unknown;
}

export interface CompiledCommandBinding<Input, Result> {
  execute(input: Input, context: CompiledCommandCallContext): Promise<Result>;
  preview?(input: Input, context: CompiledCommandCallContext): Promise<CommandPreview>;
}

/**
 * Binds static wiring, not an identity or an execution outcome.
 * All policy, replay, aspects and decoding remain in the existing command APIs.
 */
export function bindCompiledCommand<Input, Result>(
  options: CompiledCommandBindingOptions<Input, Result> & {
    preview: NonNullable<CompiledCommandBindingOptions<Input, Result>["preview"]>;
  },
): CompiledCommandBinding<Input, Result> & {
  preview(input: Input, context: CompiledCommandCallContext): Promise<CommandPreview>;
};
export function bindCompiledCommand<Input, Result>(
  options: CompiledCommandBindingOptions<Input, Result>,
): CompiledCommandBinding<Input, Result>;
export function bindCompiledCommand<Input, Result>(
  options: CompiledCommandBindingOptions<Input, Result>,
): CompiledCommandBinding<Input, Result> {
  const { module, command, governance, observer, handler, decode, preview } = options;
  return {
    execute: (input, context) => executeCompiledCommand({
      module, command, governance, observer, decode, input,
      request: context.request,
      requestContext: context.requestContext,
      services: context.services,
      scope: context.scope,
      handler: (value) => handler(value, context),
    }),
    ...(preview ? {
      preview: (input: Input, context: CompiledCommandCallContext) => previewCompiledCommand({
        module, command, governance, input,
        request: context.request,
        requestContext: context.requestContext,
        services: context.services,
        scope: context.scope,
        preview: (value) => preview(value, context),
      }),
    } : {}),
  };
}
