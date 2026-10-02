/** Internal, host-independent implementation of an owned cleanup scope. */
export function createCleanupScope() {
  type Cleanup = () => void | Promise<void>;
  const callbacks: Cleanup[] = [];
  const controller = new AbortController();
  let destroyed = false;
  let completion: Promise<void> | undefined;

  return {
    get destroyed() { return destroyed; },
    get signal() { return controller.signal; },
    onDestroy(callback: Cleanup): () => void {
      if (destroyed) {
        throw new Error("Cannot register onDestroy callback on an already destroyed DestroyRef");
      }
      // A registration, not the callback identity, owns its position.
      const registeredCallback: Cleanup = () => callback();
      callbacks.push(registeredCallback);
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        const index = callbacks.indexOf(registeredCallback);
        if (index !== -1) callbacks.splice(index, 1);
      };
    },
    destroy(): Promise<void> {
      if (completion) return completion;
      // Publish the one completion promise before invoking abort listeners or
      // cleanup code, either of which may re-enter destroy().
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      destroyed = true;
      const pending = callbacks.splice(0).reverse();
      controller.abort();
      void (async () => {
        const errors: unknown[] = [];
        for (const callback of pending) {
          try { await callback(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, "DestroyRef cleanup failed");
      })().then(resolve, reject);
      return completion;
    },
    // Retained for the existing createDestroyRef compatibility contract.
    _teardowns: callbacks,
  };
}
