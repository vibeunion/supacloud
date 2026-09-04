/**
 * Allows referring to references which are not yet defined.
 * Modeled directly after Angular's `forwardRef`.
 *
 * Example:
 * ```ts
 * @Inject(forwardRef(() => DependentService))
 * ```
 */
export interface ForwardRefFn<T = unknown> {
  (): T;
  __forward_ref__?: typeof forwardRef;
}

export function forwardRef<T>(fn: () => T): ForwardRefFn<T> {
  (fn as ForwardRefFn<T>).__forward_ref__ = forwardRef;
  return fn;
}

export function resolveForwardRef<T>(type: T): T {
  if (isForwardRef(type)) {
    return (type as unknown as () => T)();
  }
  return type;
}

export function isForwardRef(fn: unknown): fn is ForwardRefFn {
  return typeof fn === "function" && (fn as unknown as Record<string, unknown>).__forward_ref__ === forwardRef;
}
