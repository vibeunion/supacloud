export type FetchTransport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const maxBytes = 1024 * 1024;
export function createBoundedRpcFetch(
  path: RegExp,
  failure: () => Error,
  fetchImpl: FetchTransport = globalThis.fetch.bind(globalThis),
): FetchTransport {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (!path.test(url.pathname)) return fetchImpl(input, init);
    const request = new Request(input, init);
    if (request.signal.aborted) throw failure();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    request.signal.addEventListener("abort", cancel, { once: true });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const abortRead = () => { void reader?.cancel().catch(() => {}); };
    let rejectAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => { abortRead(); reject(failure()); };
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const timer = setTimeout(cancel, 15000);
    const read = async (): Promise<Response> => {
      const response = await fetchImpl(new Request(request, {
        signal: controller.signal, redirect: "error", cache: "no-store",
      }));
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw failure();
      }
      try {
        if (response.redirected || (response.status >= 300 && response.status < 400) || !response.body) throw failure();
        const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
        const length = response.headers.get("content-length");
        if (mediaType !== "application/json" || (length !== null
          && (!/^\d+$/.test(length) || Number(length) > maxBytes))) throw failure();
        reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let bytes = 0;
        let content = "";
        while (true) {
          controller.signal.throwIfAborted();
          const chunk = await reader.read();
          controller.signal.throwIfAborted();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > maxBytes) throw failure();
          content += decoder.decode(chunk.value, { stream: true });
        }
        content += decoder.decode();
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        headers.delete("content-encoding");
        return new Response(content, { status: response.status, statusText: response.statusText, headers });
      } finally {
        if (reader) {
          abortRead();
          reader.releaseLock();
        } else {
          void response.body?.cancel().catch(() => {});
        }
      }
    };
    try {
      return await Promise.race([read(), aborted]);
    } catch {
      throw failure();
    } finally {
      clearTimeout(timer);
      controller.abort();
      request.signal.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", rejectAbort);
    }
  };
}
