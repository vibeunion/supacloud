import { Module } from "./decorators";
import type { ModuleOptions } from "./decorators";
import type { Type } from "./provider";

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
