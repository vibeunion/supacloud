import { Module } from "./decorators";
import type { ModuleOptions } from "./decorators";
import type { Type } from "./provider";

export interface FeatureTransitionOptions<State extends string = string> {
  from: State;
  to: State;
  permission?: string;
  command?: string;
  route?: string;
  transaction?: "required" | "none";
  idempotency?: "required" | "none";
  audit?: string;
}

export interface FeatureSpecOptions {
  name: string;
  states: readonly string[];
  transitions: Readonly<Record<string, FeatureTransitionOptions>>;
}

export type FeatureState<Spec extends FeatureSpecOptions> = Spec["states"][number];
export type FeatureEvent<Spec extends FeatureSpecOptions> = keyof Spec["transitions"] & string;

export interface FeatureSliceOptions extends ModuleOptions {
  spec?: FeatureSpecOptions;
}

export const FEATURE_SPEC_METADATA = "supacloud:feature-spec";
export const FEATURE_SLICE_METADATA = "supacloud:feature-slice";

/**
 * Functional equivalent of the `@Module()` decorator for codebases that do
 * not enable `experimentalDecorators`. Returns a class carrying the same
 * module metadata, so it can be used interchangeably in `imports` arrays.
 */
export function defineModule(options: ModuleOptions): Type<unknown> {
  class DefinedModule {}
  Object.defineProperty(DefinedModule, "name", {
    value: options.name,
    configurable: true,
  });
  Module(options)(DefinedModule);
  return DefinedModule;
}

export function defineFeatureSpec<const T extends FeatureSpecOptions>(
  options: T & {
    transitions: Readonly<Record<string, FeatureTransitionOptions<NoInfer<T["states"][number]>>>>;
  },
): T {
  return options;
}

export function defineFeatureSlice(options: FeatureSliceOptions): Type<unknown> {
  const module = defineModule(options);
  Object.defineProperty(module, FEATURE_SLICE_METADATA, {
    value: options,
    configurable: true,
  });
  if (options.spec) {
    Object.defineProperty(module, FEATURE_SPEC_METADATA, {
      value: options.spec,
      configurable: true,
    });
  }
  return module;
}
