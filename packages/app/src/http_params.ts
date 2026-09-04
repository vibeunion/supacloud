/**
 * Angular-inspired immutable HttpParams query parameter builder.
 * Modeled after Angular's @angular/common/http HttpParams API.
 */

export interface HttpParamsOptions {
  /** String in standard query string format (e.g. 'a=1&b=2') */
  fromString?: string;
  /** Object mapping parameter names to primitive values or arrays */
  fromObject?: Record<string, string | number | boolean | ReadonlyArray<string | number | boolean>>;
}

export class HttpParams {
  private readonly map: Map<string, string[]>;

  constructor(options?: HttpParamsOptions) {
    this.map = new Map<string, string[]>();
    if (!options) return;

    if (options.fromString) {
      const raw = options.fromString.startsWith("?") ? options.fromString.slice(1) : options.fromString;
      if (raw.length > 0) {
        const pairs = raw.split("&");
        for (const pair of pairs) {
          if (!pair) continue;
          const eqIndex = pair.indexOf("=");
          const rawKey = eqIndex >= 0 ? pair.slice(0, eqIndex) : pair;
          const rawVal = eqIndex >= 0 ? pair.slice(eqIndex + 1) : "";
          const key = decodeURIComponent(rawKey.replace(/\+/g, " "));
          const val = decodeURIComponent(rawVal.replace(/\+/g, " "));
          const existing = this.map.get(key) ?? [];
          existing.push(val);
          this.map.set(key, existing);
        }
      }
    }

    if (options.fromObject) {
      for (const [key, val] of Object.entries(options.fromObject)) {
        if (val === undefined || val === null) continue;
        if (Array.isArray(val)) {
          this.map.set(key, val.map((v) => String(v)));
        } else {
          this.map.set(key, [String(val)]);
        }
      }
    }
  }

  private clone(newMap: Map<string, string[]>): HttpParams {
    const clone = new HttpParams();
    for (const [k, v] of newMap.entries()) {
      (clone.map as Map<string, string[]>).set(k, [...v]);
    }
    return clone;
  }

  has(param: string): boolean {
    return this.map.has(param);
  }

  get(param: string): string | null {
    const values = this.map.get(param);
    return values && values.length > 0 ? values[0] : null;
  }

  getAll(param: string): string[] | null {
    const values = this.map.get(param);
    return values ? [...values] : null;
  }

  keys(): string[] {
    return Array.from(this.map.keys());
  }

  set(param: string, value: string | number | boolean): HttpParams {
    const newMap = new Map(this.map);
    newMap.set(param, [String(value)]);
    return this.clone(newMap);
  }

  append(param: string, value: string | number | boolean): HttpParams {
    const newMap = new Map(this.map);
    const existing = newMap.get(param) ? [...newMap.get(param)!] : [];
    existing.push(String(value));
    newMap.set(param, existing);
    return this.clone(newMap);
  }

  delete(param: string, value?: string | number | boolean): HttpParams {
    if (!this.map.has(param)) return this;
    const newMap = new Map(this.map);
    if (value === undefined) {
      newMap.delete(param);
    } else {
      const target = String(value);
      const existing = newMap.get(param)!.filter((v) => v !== target);
      if (existing.length === 0) {
        newMap.delete(param);
      } else {
        newMap.set(param, existing);
      }
    }
    return this.clone(newMap);
  }

  toString(): string {
    const parts: string[] = [];
    for (const [key, values] of this.map.entries()) {
      const encodedKey = encodeURIComponent(key);
      for (const val of values) {
        parts.push(`${encodedKey}=${encodeURIComponent(val)}`);
      }
    }
    return parts.join("&");
  }
}
