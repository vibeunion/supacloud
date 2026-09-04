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
    if (this.map.has(token as HttpContextToken<unknown>)) {
      return this.map.get(token as HttpContextToken<unknown>) as T;
    }
    return token.defaultValue();
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
