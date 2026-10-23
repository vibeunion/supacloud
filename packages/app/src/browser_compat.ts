/**
 * Optional browser compatibility entrypoint.
 *
 * SupaCloud browser bundles may run on managed enterprise browsers that are
 * older than the APIs used by bundled dependencies (for example TypeBox calls
 * `URL.canParse` while compiling schemas). Import this module first and call
 * `installBrowserCompatPolyfills()` before mounting an application:
 *
 * ```ts
 * import { installBrowserCompatPolyfills } from "@supacloud/app/browser-compat";
 * installBrowserCompatPolyfills();
 * ```
 *
 * Every installer only fills a missing implementation. Native implementations
 * are never replaced, and this module has no effect in modern browsers.
 */

type CanParseTarget = { canParse?: unknown };
type AbortSignalAnyTarget = { any?: unknown };

interface RandomUuidSource {
  getRandomValues?: <T extends ArrayBufferView | null>(array: T) => T;
  randomUUID?: () => string;
}

/** URL.canParse equivalent; resolves relative references only with a base. */
export function canParseUrl(url: string | URL, base?: string | URL): boolean {
  try {
    new URL(url, base as string | URL | undefined);
    return true;
  } catch {
    return false;
  }
}

/** Fill URL.canParse when the runtime predates Chromium 120. */
export function installUrlCanParsePolyfill(target: CanParseTarget = URL): void {
  if (!target || typeof target.canParse === "function") return;
  Object.defineProperty(target, "canParse", {
    configurable: true,
    writable: true,
    value: canParseUrl,
  });
}

/** AbortSignal.any equivalent; aborts when any input signal aborts. */
export function anyAbortSignal(signals: Iterable<AbortSignal>): AbortSignal {
  const controller = new AbortController();
  const list = Array.from(signals);
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
  }
  const onAbort = (event: Event): void => {
    const signal = event.target as AbortSignal;
    controller.abort(signal.reason);
    for (const item of list) item.removeEventListener("abort", onAbort);
  };
  for (const signal of list) signal.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

/** Fill AbortSignal.any when the runtime predates Chromium 116. */
export function installAbortSignalAnyPolyfill(target: AbortSignalAnyTarget = AbortSignal): void {
  if (!target || typeof target.any === "function") return;
  Object.defineProperty(target, "any", {
    configurable: true,
    writable: true,
    value: (signals: Iterable<AbortSignal>) => anyAbortSignal(signals),
  });
}

function formatUuidV4(bytes: Uint8Array): string {
  // RFC 4122 version 4 + variant 10xx.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Secure UUID fallback for restricted or older browser contexts. */
export function randomUuid(source: RandomUuidSource = globalThis.crypto): string {
  if (typeof source?.randomUUID === "function") {
    try {
      return source.randomUUID();
    } catch {
      // Some contexts expose randomUUID but reject it outside secure contexts.
    }
  }
  if (typeof source?.getRandomValues === "function") {
    return formatUuidV4(source.getRandomValues(new Uint8Array(16)));
  }
  throw new Error("No secure random source is available; upgrade the browser or serve the app over HTTPS.");
}

/** Fill crypto.randomUUID without falling back to Math.random. */
export function installRandomUuidPolyfill(target: RandomUuidSource = globalThis.crypto): void {
  if (!target || typeof target.randomUUID === "function" || typeof target.getRandomValues !== "function") return;
  Object.defineProperty(target, "randomUUID", {
    configurable: true,
    writable: true,
    value: () => randomUuid(target),
  });
}

/** Install all optional browser compatibility shims. Safe to call repeatedly. */
export function installBrowserCompatPolyfills(): void {
  installRandomUuidPolyfill();
  installUrlCanParsePolyfill();
  installAbortSignalAnyPolyfill();
}