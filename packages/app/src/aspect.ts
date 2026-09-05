/**
 * Static application aspect contract.
 *
 * Aspects are explicit functions referenced by Module/Route/Command metadata.
 * The compiler resolves those references and emits a direct invocation chain.
 */
export type AspectKind = "route" | "command" | "job";

export interface AspectContext {
  kind: AspectKind;
  name: string;
  input: unknown;
  request?: Request;
  requestContext?: unknown;
  scope?: Record<string, unknown>;
  services?: Record<string, unknown>;
  metadata?: unknown;
}

export type AspectNext<TResult = unknown> = () => TResult | Promise<TResult>;

export type Aspect<TResult = unknown> = (
  context: AspectContext,
  next: AspectNext<TResult>,
) => TResult | Promise<TResult>;

export type RouteAspect = Aspect;
export type CommandAspect = Aspect;
export type JobAspect = Aspect;
