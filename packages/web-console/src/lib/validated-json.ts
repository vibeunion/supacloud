import { readBoundedText } from "./http-body";

export class InvalidJsonResponse extends Error {
  constructor() { super("Invalid JSON response"); }
}

export interface JsonResponsePolicy {
  statuses?: readonly number[];
  maxBytes?: number;
}

export async function requestValidatedJson<T>(
  url: string,
  request: (url: string, options: RequestInit) => Promise<Response>,
  decode: (value: unknown, status: number) => T,
  options: RequestInit = {},
  policy: JsonResponsePolicy = {},
): Promise<T> {
  const { signal, ...requestOptions } = options;
  const maxBytes = policy.maxBytes ?? 8 * 1024 * 1024;
  const statuses = new Set(policy.statuses ?? [200]);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || statuses.size === 0
    || [...statuses].some(status => !Number.isInteger(status) || status < 200 || status > 599)) {
    throw new InvalidJsonResponse();
  }
  const controller = new AbortController();
  const stopped = Promise.withResolvers<never>();
  const abort = () => {
    controller.abort();
    stopped.reject(new DOMException("JSON request aborted", "AbortError"));
  };
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 15_000);
  const reading = Promise.resolve().then(async () => {
    controller.signal.throwIfAborted();
    const response = await request(url, { ...requestOptions, signal: controller.signal, redirect: "error" });
    try {
      controller.signal.throwIfAborted();
      if (!statuses.has(response.status) || response.redirected) throw new InvalidJsonResponse();
      let value: unknown;
      try {
        value = JSON.parse(await readBoundedText(response, maxBytes, controller.signal));
      } catch {
        controller.signal.throwIfAborted();
        throw new InvalidJsonResponse();
      }
      return decode(value, response.status);
    } finally {
      void response.body?.cancel().catch(() => {});
    }
  });
  try {
    return await Promise.race([reading, stopped.promise]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
