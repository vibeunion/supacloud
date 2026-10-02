/**
 * Angular-inspired typed HTTP context token and context bag.
 * Modeled after Angular's @angular/common/http HttpContext and HttpContextToken API.
 */

export class HttpContextToken<T> {
  constructor(readonly defaultValue: () => T) {}
}

export class HttpContext {
  private readonly map = new Map<HttpContextToken<unknown>, unknown>();

  set<T>(token: HttpContextToken<T>, value: T): this {
    this.map.set(token as HttpContextToken<unknown>, value);
    return this;
  }

  get<T>(token: HttpContextToken<T>): T {
    if (!this.map.has(token)) {
      // Materialize once per context, including undefined and mutable defaults.
      // A throwing factory does not leave a partially initialized entry.
      this.map.set(token, token.defaultValue());
    }
    return this.map.get(token) as T;
  }

  delete(token: HttpContextToken<unknown>): this {
    this.map.delete(token);
    return this;
  }

  has(token: HttpContextToken<unknown>): boolean {
    return this.map.has(token);
  }

  keys(): IterableIterator<HttpContextToken<unknown>> {
    return this.map.keys();
  }
}
