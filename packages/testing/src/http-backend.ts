/** A deterministic fetch backend for the real SDK/HTTP client; never sends network traffic. */
export type HttpRequestMatcher = string | ((request: Request) => boolean);
export interface CapturedHttpRequest {
  readonly request: Request;
  readonly cancelled: boolean;
  readonly settled: boolean;
  respond(response: Response): void;
  flush(body: unknown, init?: ResponseInit): void;
  error(reason: unknown): void;
}
export interface HttpTestBackend {
  fetch: typeof globalThis.fetch;
  expectOne(matcher: HttpRequestMatcher): CapturedHttpRequest;
  expectNone(matcher: HttpRequestMatcher): void;
  match(matcher: HttpRequestMatcher): CapturedHttpRequest[];
  verify(options?: { ignoreCancelled?: boolean }): void;
  dispose(): void;
}

type Entry = CapturedHttpRequest & { matched: boolean };

export function createHttpTestBackend(options: { capacity?: number } = {}): HttpTestBackend {
  const capacity = options.capacity ?? 256;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 65536) throw new RangeError("Invalid HTTP test capacity");
  const entries: Entry[] = [];
  let disposed = false;
  const select = (matcher: HttpRequestMatcher) => entries.filter(entry => !entry.matched
    && (typeof matcher === "string" ? entry.request.url === matcher : matcher(entry.request)));
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (disposed) throw new Error("HTTP test backend is disposed");
    if (entries.length >= capacity) throw new RangeError("HTTP test request capacity exceeded");
    const request = new Request(input, init);
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      let cancelled = false;
      const finish = (value: Response | unknown, failed: boolean) => {
        if (settled) throw new Error("HTTP test request already settled");
        settled = true;
        request.signal.removeEventListener("abort", abort);
        if (failed) reject(value); else resolve(value as Response);
      };
      const abort = () => {
        if (settled) return;
        cancelled = true;
        finish(request.signal.reason ?? new DOMException("Request aborted", "AbortError"), true);
      };
      const entry: Entry = {
        request, matched: false,
        get cancelled() { return cancelled; },
        get settled() { return settled; },
        respond(response) { finish(response, false); },
        flush(body, responseInit) { finish(Response.json(body, responseInit), false); },
        error(reason) { finish(reason, true); },
      };
      entries.push(entry);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
    });
  }) as typeof globalThis.fetch;
  return {
    fetch,
    expectOne(matcher) {
      const matches = select(matcher);
      if (matches.length !== 1) throw new Error(`Expected one unmatched HTTP request, found ${matches.length}`);
      const entry = matches[0]!;
      entry.matched = true;
      return entry;
    },
    expectNone(matcher) {
      if (select(matcher).length > 0) throw new Error("Unexpected HTTP request");
    },
    match(matcher) {
      const matches = select(matcher);
      for (const entry of matches) entry.matched = true;
      return matches;
    },
    verify(verifyOptions = {}) {
      const outstanding = entries.filter(entry => !(verifyOptions.ignoreCancelled && entry.cancelled)
        && (!entry.matched || !entry.settled));
      // Deliberately omit URL/body/headers, which can include test credentials.
      if (outstanding.length) throw new Error(`${outstanding.length} unmatched or unsettled HTTP test request(s)`);
    },
    dispose() {
      disposed = true;
      for (const entry of entries) if (!entry.settled) entry.error(new Error("HTTP test backend disposed"));
    },
  };
}
