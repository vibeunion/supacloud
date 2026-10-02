/** Official RxJS adapters. No runtime import of the SDK root or a second Supabase client. */
import { Observable } from "rxjs";
import type {
  SupaCloudTaskReceipt,
  SupaCloudTaskSnapshot,
  SupaCloudTaskSubscribeOptions,
} from "./index.js";

export interface ObserveQueryOptions {
  /** Owner cancellation completes observation and aborts cooperative I/O. */
  signal?: AbortSignal;
}

/**
 * Create a fresh read/query per subscription, including Supabase PromiseLike builders.
 * Keeps the original response envelope (data/count/status); error envelopes enter error().
 * Pass the provided signal to .abortSignal(signal) or the native SDK request options.
 * No retries, global cache or sharing. Keep commands/submission on their awaited SDK APIs.
 */
export function observeQuery<TResponse extends { error: unknown }>(
  query: (signal: AbortSignal) => PromiseLike<TResponse>,
  options: ObserveQueryOptions = {},
): Observable<TResponse> {
  const signal = options.signal;
  return new Observable<TResponse>(subscriber => {
    if (signal?.aborted) {
      subscriber.complete();
      return;
    }
    const controller = new AbortController();
    let pending = true;
    const abort = () => subscriber.complete();
    subscriber.add(() => {
      signal?.removeEventListener("abort", abort);
      if (pending) controller.abort(signal?.reason);
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    let work: PromiseLike<TResponse>;
    try { work = query(controller.signal); }
    catch (error) { subscriber.error(error); return; }
    void Promise.resolve(work).then(response => {
      pending = false;
      if (subscriber.closed) return;
      try {
        if (response.error !== null && response.error !== undefined) {
          subscriber.error(response.error);
          return;
        }
        subscriber.next(response);
        subscriber.complete();
      } catch (error) { subscriber.error(error); }
    }, error => {
      pending = false;
      subscriber.error(error);
    });
  });
}

export type ObserveTaskOptions = Omit<
  SupaCloudTaskSubscribeOptions,
  "onUpdate" | "onError" | "onStateChange"
> & { signal?: AbortSignal };

/**
 * Observe an EXISTING task receipt, preserving its project binding and result decoder.
 * Each subscriber owns its SDK subscription; unsubscribe never calls task.cancel/retry.
 * SDK read/decoder failures terminate the stream. SDK Realtime->polling fallback is retained.
 * Terminal business states are emitted normally, then the SDK's closed state completes it.
 */
export function observeTask<TResult>(
  task: Pick<SupaCloudTaskReceipt<TResult>, "subscribe">,
  options: ObserveTaskOptions = {},
): Observable<SupaCloudTaskSnapshot<TResult>> {
  const { signal, ...settings } = options;
  const captured = {
    ...settings,
    ...(settings.realtime ? { realtime: { ...settings.realtime } } : {}),
  };
  return new Observable<SupaCloudTaskSnapshot<TResult>>(subscriber => {
    const abort = () => subscriber.complete();
    subscriber.add(() => signal?.removeEventListener("abort", abort));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { subscriber.complete(); return; }
    const subscription = task.subscribe({
      ...captured,
      onUpdate: snapshot => subscriber.next(snapshot),
      onError: error => subscriber.error(error),
      onStateChange: state => { if (state === "closed") subscriber.complete(); },
    });
    // add() also releases handles returned AFTER a synchronous complete/error/abort.
    subscriber.add(() => subscription.unsubscribe());
  });
}
