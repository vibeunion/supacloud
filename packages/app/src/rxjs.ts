import type { DestroyRef as AngularDestroyRef, Signal } from "@angular/core";
import {
  takeUntilDestroyed as angularTakeUntilDestroyed,
  toSignal as angularToSignal,
} from "@angular/core/rxjs-interop";
import { defer, EMPTY, type MonoTypeOperatorFunction, type Observable } from "rxjs";
import type { DestroyRef } from "./context";

/** An explicitly owned SupaCloud scope; never resolves a global injector. */
export type ReactiveScope = DestroyRef & { readonly destroyed?: boolean };

/**
 * Reuses Angular's operator with a SupaCloud lifetime. Abort stops consumption
 * synchronously, even if asynchronous scope teardown has not finished yet.
 * Cancellation of the underlying operation still requires its own teardown.
 */
export function takeUntilDestroyed<T>(scope: ReactiveScope): MonoTypeOperatorFunction<T> {
  const owner: AngularDestroyRef = {
    get destroyed() { return scope.destroyed === true || scope.signal?.aborted === true; },
    onDestroy(callback) {
      let notified = false;
      const notify = () => {
        if (notified) return;
        notified = true;
        callback();
      };
      const unregister = scope.onDestroy(notify);
      scope.signal?.addEventListener("abort", notify, { once: true });
      return () => {
        unregister();
        scope.signal?.removeEventListener("abort", notify);
      };
    },
  };
  // A destroyed owner must not subscribe to (and thus start) a cold source.
  return (source) => defer(() => owner.destroyed
    ? EMPTY
    : source.pipe(angularTakeUntilDestroyed<T>(owner)));
}

/**
 * Official Angular Signal backed by a scope-owned Observable subscription.
 * Requires an initial state and an explicit lifetime, but no Angular app host.
 * This is latest state, not a lossless event log. Source errors throw on read.
 */
export function toScopedSignal<T>(
  source: Observable<T>,
  options: { destroyRef: ReactiveScope; initialValue: T },
): Signal<T> {
  return angularToSignal<T, T>(source.pipe(takeUntilDestroyed(options.destroyRef)), {
    initialValue: options.initialValue,
    // The operator above owns cleanup; do not register a second Angular owner.
    manualCleanup: true,
  });
}
