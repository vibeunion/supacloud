import type { AnyElysia, Elysia } from "elysia";
import {
  createApplication,
  type ApplicationOptions,
  type CompiledModule,
} from "./index";

/**
 * Experimental profile for evaluating SupaCloud application composition.
 *
 * This intentionally remains a thin profile over createApplication. It owns
 * SupaCloud defaults without wrapping or reimplementing Elysia's API.
 */
export interface SupaCloudFrameworkOptions<
  Http extends AnyElysia = Elysia,
  RequestContext = unknown,
> extends Omit<ApplicationOptions<Http, RequestContext>, "name" | "normalize" | "modules"> {
  /** Application modules in compiler-emitted topological order. */
  modules?: CompiledModule[];
  /** Public application name used in diagnostics and Elysia plugin identity. */
  name: string;
  /**
   * Reject extra properties rather than silently removing them.
   */
  normalize?: false;
}

export function createSupaCloudFramework<
  const Http extends AnyElysia = Elysia,
  RequestContext = unknown,
>(options: SupaCloudFrameworkOptions<Http, RequestContext>) {
  return createApplication({
    ...options,
    normalize: options.normalize ?? false,
    modules: options.modules ?? [],
  });
}
