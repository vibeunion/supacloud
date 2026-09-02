import type { Scope } from "./scope";

export interface InjectionTokenOptions<T> {
  /** Optional default factory used when no explicit provider is registered. */
  factory?: () => T;
  /** Default scope when the token itself is used as a provider. */
  scope?: Scope;
}

/**
 * Lightweight injection token, modeled after Angular's tree-shakable tokens.
 * Used as a DI key for interfaces and values that are not classes.
 */
export class InjectionToken<T> {
  readonly name: string;
  readonly factory?: () => T;
  readonly scope?: Scope;

  constructor(name: string, options: InjectionTokenOptions<T> = {}) {
    this.name = name;
    this.factory = options.factory;
    this.scope = options.scope;
  }

  toString(): string {
    return `InjectionToken ${this.name}`;
  }
}
