import { Module } from "./decorators";
import type { ModuleOptions } from "./decorators";
import type { Type } from "./provider";

export interface FeatureTransitionOptions<State extends string = string> {
  from: State;
  to: State;
  permission?: string;
  command?: string;
  route?: string;
  /** Route binding mode: framework command binding or an explicit controller invocation. */
  routeBinding?: "command" | "controller";
  transaction?: "required" | "none";
  idempotency?: "required" | "none";
  audit?: string;
  /** Job that continues the transition after the durable write is committed. */
  job?: string;
  /** Explicit query tags invalidated after the transition succeeds. */
  invalidateTags?: readonly string[];
  persistence?: FeaturePersistenceOptions;
}

export interface FeaturePersistenceOptions {
  boundary: "database" | "external";
  optimisticLock: "required" | "none";
  versionField?: string;
  tenantField?: string;
  stateField?: string;
  receipt: "required" | "none";
  reconciliation: "required" | "none";
}

export interface FeatureDatabaseSourceOptions {
  /** Project-relative database source configuration or schema entrypoint. */
  source: string;
  /** Schema-qualified table name owned by the feature. */
  table: string;
  /** Exported row type derived from the database source. */
  rowType: string;
}

export interface FeatureSpecOptions {
  name: string;
  states: readonly string[];
  database?: FeatureDatabaseSourceOptions;
  tenantField?: string;
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
