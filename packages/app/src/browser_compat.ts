/**
 * Optional browser compatibility entrypoint.
 *
 * Managed enterprise browsers may be older than the APIs used by bundled
 * dependencies. For example, TypeBox calls `URL.canParse` while compiling
 * schemas, and a Chromium 115 client fails after a valid response arrives.
 *
 * Import this module first and install the baseline before mounting:
 *
 * ```ts
 * import { installBrowserCompatPolyfills } from "@supacloud/app/browser-compat";
 * const report = installBrowserCompatPolyfills();
 * ```
 *
 * Design rules:
 * - feature detection only, never user-agent sniffing;
 * - every installer is idempotent and only fills a missing function;
 * - native implementations are never replaced;
 * - the install report distinguishes native, polyfilled, and unavailable APIs;
 * - no insecure fallback such as `Math.random` for UUID generation.
 */

type CanParseTarget = { canParse?: unknown };
type AbortSignalAnyTarget = { any?: unknown };

interface RandomUuidSource {
  getRandomValues?: <T extends ArrayBufferView | null>(array: T) => T;
  randomUUID?: () => string;
}

export type BrowserCompatFeature = "url.canParse" | "abortSignal.any" | "crypto.randomUUID";

export interface BrowserCompatTargets {
  /** Usually `URL`; injectable for tests or a non-global realm. */
  url?: CanParseTarget;
  /** Usually `AbortSignal`; injectable for tests or a non-global realm. */
  abortSignal?: AbortSignalAnyTarget;
  /** Usually `globalThis.crypto`; injectable for tests or a non-global realm. */
  crypto?: RandomUuidSource;
}

export interface BrowserCompatInstallReport {
  /** Features that now have either a native or polyfilled implementation. */
  ready: BrowserCompatFeature[];
  /** Features this call actually polyfilled. */
  polyfilled: BrowserCompatFeature[];
  /** Features that remain unavailable, for example without a secure random source. */
  unavailable: BrowserCompatFeature[];
}

/** URL.canParse equivalent; relative references resolve only with a base. */
export function canParseUrl(url: string | URL, base?: string | URL): boolean {
  try {
    new URL(url, base as string | URL | undefined);
    return true;
  } catch {
    return false;
  }
}

/** Fill URL.canParse when the runtime predates Chromium 120. Returns true if installed. */
export function installUrlCanParsePolyfill(target: CanParseTarget = URL): boolean {
  if (!target || typeof target.canParse === "function") return false;
  Object.defineProperty(target, "canParse", {
    configurable: true,
    writable: true,
    value: canParseUrl,
  });
  return true;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AbortSignal>;
  return typeof candidate.aborted === "boolean"
    && typeof candidate.addEventListener === "function"
    && typeof candidate.removeEventListener === "function";
}

/**
 * AbortSignal.any equivalent.
 *
 * Validates the input sequence and propagates the first abort reason. A
 * pre-aborted input aborts the composite immediately; no listeners are left
 * attached to the source signals after the composite aborts.
 */
export function anyAbortSignal(signals: Iterable<AbortSignal>): AbortSignal {
  const list: AbortSignal[] = [];
  for (const signal of signals) {
    if (!isAbortSignal(signal)) throw new TypeError("AbortSignal.any expects an iterable of AbortSignal instances");
    list.push(signal);
  }

  const controller = new AbortController();
  let settled = false;
  const abortFrom = (signal: AbortSignal): void => {
    if (settled) return;
    settled = true;
    for (const item of list) item.removeEventListener("abort", onAbort);
    controller.abort(signal.reason);
  };
  const onAbort = (event: Event): void => {
    abortFrom(event.target as AbortSignal);
  };

  for (const signal of list) {
    if (signal.aborted) {
      abortFrom(signal);
      return controller.signal;
    }
  }
  for (const signal of list) {
    // Re-check after attaching to close the gap for custom signal objects.
    if (signal.aborted) {
      abortFrom(signal);
      return controller.signal;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

/** Fill AbortSignal.any when the runtime predates Chromium 116. Returns true if installed. */
export function installAbortSignalAnyPolyfill(target: AbortSignalAnyTarget = AbortSignal): boolean {
  if (!target || typeof target.any === "function") return false;
  Object.defineProperty(target, "any", {
    configurable: true,
    writable: true,
    value: anyAbortSignal,
  });
  return true;
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

/** Fill crypto.randomUUID without falling back to Math.random. Returns true if installed. */
export function installRandomUuidPolyfill(target: RandomUuidSource | undefined = globalThis.crypto): boolean {
  if (!target || typeof target.randomUUID === "function" || typeof target.getRandomValues !== "function") return false;
  Object.defineProperty(target, "randomUUID", {
    configurable: true,
    writable: true,
    value: () => randomUuid(target),
  });
  return true;
}

/**
 * Install the optional browser compatibility baseline.
 *
 * Safe to call repeatedly. Pass explicit targets only when installing into a
 * non-global realm or in tests; ordinary applications should call it with no
 * arguments before mounting.
 */
export function installBrowserCompatPolyfills(targets: BrowserCompatTargets = {}): BrowserCompatInstallReport {
  const url = targets.url ?? URL;
  const abortSignal = targets.abortSignal ?? AbortSignal;
  const crypto = targets.crypto ?? globalThis.crypto;
  const report: BrowserCompatInstallReport = { ready: [], polyfilled: [], unavailable: [] };

  const record = (feature: BrowserCompatFeature, native: boolean, installed: boolean): void => {
    if (installed) report.polyfilled.push(feature);
    if (native || installed) report.ready.push(feature);
    else report.unavailable.push(feature);
  };

  record("url.canParse", typeof url?.canParse === "function", installUrlCanParsePolyfill(url));
  record("abortSignal.any", typeof abortSignal?.any === "function", installAbortSignalAnyPolyfill(abortSignal));
  record("crypto.randomUUID", typeof crypto?.randomUUID === "function", installRandomUuidPolyfill(crypto));

  return report;
}