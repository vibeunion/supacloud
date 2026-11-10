import type { Scope } from "./scope";

export interface InjectionTokenOptions<T> {
  /** Optional default factory used when no explicit provider is registered. */
  factory?: () => T;
  /** Record that a compiler-visible root provider exists. This does not register an Angular provider. */
  providedIn?: "root";
  /** Default scope when the token itself is used as a provider. */
  scope?: Scope;
}

/**
 * Local injection token. Identity is the object itself.
 * `/core` does not subclass or import `@angular/core`.
 */
export class InjectionToken<T> {
  readonly name: string;
  readonly factory?: () => T;
  readonly providedIn?: "root";
  readonly scope?: Scope;

  constructor(name: string, options: InjectionTokenOptions<T> = {}) {
    this.name = name;
    if (options.factory !== undefined) this.factory = options.factory;
    if (options.providedIn !== undefined) this.providedIn = options.providedIn;
    if (options.scope !== undefined) this.scope = options.scope;
  }

  toString(): string {
    return `InjectionToken ${this.name}`;
  }
}
