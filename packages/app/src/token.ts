import type { Scope } from "./scope";
import { InjectionToken as AngularInjectionToken } from "@angular/core";

export interface InjectionTokenOptions<T> {
  /** Optional default factory used when no explicit provider is registered. */
  factory?: () => T;
  /** Automatically provide in the root injector context without manual module declaration (Angular tree-shakable provider). */
  providedIn?: "root";
  /** Default scope when the token itself is used as a provider. */
  scope?: Scope;
}

/**
 * Lightweight injection token, modeled after Angular's tree-shakable tokens.
 * Used as a DI key for interfaces and values that are not classes.
 */
export class InjectionToken<T> extends AngularInjectionToken<T> {
  readonly name: string;
  readonly factory?: () => T;
  readonly providedIn?: "root";
  readonly scope?: Scope;

  constructor(name: string, options: InjectionTokenOptions<T> = {}) {
    if (options.factory) {
      super(name, {
        providedIn: options.providedIn ?? null,
        factory: options.factory,
      });
    } else {
      super(name);
    }
    this.name = name;
    this.factory = options.factory;
    this.providedIn = options.providedIn;
    this.scope = options.scope;
  }

  toString(): string {
    return `InjectionToken ${this.name}`;
  }
}
