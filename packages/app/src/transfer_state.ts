import { InjectionToken } from "./token";

export type StateKey<T> = string & { readonly __type_brand?: T };

/**
 * Creates a type-safe StateKey for TransferState.
 * Modeled directly after Angular's makeStateKey.
 */
export function makeStateKey<T>(key: string): StateKey<T> {
  return key as StateKey<T>;
}

/**
 * Key-value store used to transfer application state between server and client (SSR / Edge hydration).
 * Modeled directly after Angular Universal TransferState.
 */
export class TransferState {
  private store = new Map<string, unknown>();

  /**
   * Retrieves the value associated with the key, or defaultValue if not present.
   */
  get<T>(key: StateKey<T> | string, defaultValue: T): T {
    if (this.store.has(key as string)) {
      return this.store.get(key as string) as T;
    }
    return defaultValue;
  }

  /**
   * Sets the value for the given key.
   */
  set<T>(key: StateKey<T> | string, value: T): void {
    this.store.set(key as string, value);
  }

  /**
   * Checks whether the key exists in the store.
   */
  hasKey<T>(key: StateKey<T> | string): boolean {
    return this.store.has(key as string);
  }

  /**
   * Removes a key from the store.
   */
  remove<T>(key: StateKey<T> | string): void {
    this.store.delete(key as string);
  }

  /**
   * Checks whether the store is empty.
   */
  isEmpty(): boolean {
    return this.store.size === 0;
  }

  /**
   * Serializes the current state store into a JSON string.
   */
  toJson(): string {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of this.store.entries()) {
      obj[k] = v;
    }
    return JSON.stringify(obj);
  }

  /**
   * Deserializes a JSON string into a TransferState store.
   */
  static fromJson(json: string): TransferState {
    const state = new TransferState();
    try {
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed === "object" && parsed !== null) {
        for (const [k, v] of Object.entries(parsed)) {
          state.set(k, v);
        }
      }
    } catch {
      // ignore parse error, return empty state
    }
    return state;
  }

  /**
   * Creates a TransferState initialized with a plain record object.
   */
  static fromObject(record: Record<string, unknown>): TransferState {
    const state = new TransferState();
    for (const [k, v] of Object.entries(record)) {
      state.set(k, v);
    }
    return state;
  }
}

/**
 * Built-in injection token for TransferState.
 */
export const TRANSFER_STATE = new InjectionToken<TransferState>("supacloud.transfer-state", {
  scope: "application",
  factory: () => new TransferState(),
});
