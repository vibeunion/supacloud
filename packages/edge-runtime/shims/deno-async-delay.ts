// Deno async/delay.ts shim
// Maps Deno's delay function directly to Bun.sleep 

/**
 * Resolve a Promise after a given amount of milliseconds.
 */
export async function delay(ms: number, options?: { signal?: AbortSignal }): Promise<void> {
  if (options?.signal?.aborted) {
    return Promise.reject(new DOMException("Delay was aborted.", "AbortError"));
  }
  
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    
    if (options?.signal) {
      options.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Delay was aborted.", "AbortError"));
      });
    }
  });
}
