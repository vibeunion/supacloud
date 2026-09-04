/**
 * Angular-inspired immutable HttpHeaders builder.
 * Modeled after Angular's @angular/common/http HttpHeaders API.
 * Header names are treated case-insensitively.
 */

export class HttpHeaders {
  private readonly headersMap: Map<string, string[]>;
  private readonly originalNames: Map<string, string>;

  constructor(headers?: Record<string, string | string[]> | HttpHeaders) {
    this.headersMap = new Map<string, string[]>();
    this.originalNames = new Map<string, string>();
    if (!headers) return;

    if (headers instanceof HttpHeaders) {
      for (const [k, v] of headers.headersMap.entries()) {
        this.headersMap.set(k, [...v]);
        this.originalNames.set(k, headers.originalNames.get(k) ?? k);
      }
      return;
    }

    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined || value === null) continue;
      const lower = key.toLowerCase();
      this.originalNames.set(lower, key);
      if (Array.isArray(value)) {
        this.headersMap.set(lower, [...value]);
      } else {
        this.headersMap.set(lower, [String(value)]);
      }
    }
  }

  private clone(newMap: Map<string, string[]>, newNames: Map<string, string>): HttpHeaders {
    const clone = new HttpHeaders();
    for (const [k, v] of newMap.entries()) {
      (clone.headersMap as Map<string, string[]>).set(k, [...v]);
    }
    for (const [k, v] of newNames.entries()) {
      (clone.originalNames as Map<string, string>).set(k, v);
    }
    return clone;
  }

  has(name: string): boolean {
    return this.headersMap.has(name.toLowerCase());
  }

  get(name: string): string | null {
    const values = this.headersMap.get(name.toLowerCase());
    return values && values.length > 0 ? values[0] : null;
  }

  getAll(name: string): string[] | null {
    const values = this.headersMap.get(name.toLowerCase());
    return values ? [...values] : null;
  }

  keys(): string[] {
    return Array.from(this.originalNames.values());
  }

  set(name: string, value: string | string[]): HttpHeaders {
    const lower = name.toLowerCase();
    const newMap = new Map(this.headersMap);
    const newNames = new Map(this.originalNames);
    const valArray = Array.isArray(value) ? [...value] : [String(value)];
    newMap.set(lower, valArray);
    newNames.set(lower, name);
    return this.clone(newMap, newNames);
  }

  append(name: string, value: string | string[]): HttpHeaders {
    const lower = name.toLowerCase();
    const newMap = new Map(this.headersMap);
    const newNames = new Map(this.originalNames);
    const existing = newMap.get(lower) ? [...newMap.get(lower)!] : [];
    if (Array.isArray(value)) {
      existing.push(...value);
    } else {
      existing.push(String(value));
    }
    newMap.set(lower, existing);
    if (!newNames.has(lower)) {
      newNames.set(lower, name);
    }
    return this.clone(newMap, newNames);
  }

  delete(name: string): HttpHeaders {
    const lower = name.toLowerCase();
    if (!this.headersMap.has(lower)) return this;
    const newMap = new Map(this.headersMap);
    const newNames = new Map(this.originalNames);
    newMap.delete(lower);
    newNames.delete(lower);
    return this.clone(newMap, newNames);
  }

  toObject(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [lower, values] of this.headersMap.entries()) {
      const originalName = this.originalNames.get(lower) ?? lower;
      result[originalName] = values.join(", ");
    }
    return result;
  }
}
