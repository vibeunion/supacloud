/**
 * Browser-side immutable frontend release discovery.
 *
 * The platform serves a no-store release pointer for immutable static
 * deployments. The default watcher reloads automatically when that is safe:
 * immediately while the tab is hidden, or after an idle period when the page is
 * visible. Editable focus, modal dialogs and explicit unsaved/busy markers defer
 * the reload. Applications can still provide their own prompt through the
 * update event or opt out with `autoReload: "never"`.
 */

export const FRONTEND_RELEASE_POINTER_PATH = "/.well-known/supacloud-frontend-release";
export const FRONTEND_RELEASE_POINTER_SCHEMA = "supacloud.frontend-release-pointer.v1";
export const FRONTEND_UPDATE_EVENT = "supacloud:frontend-update-available";

const RELEASE_ID_PATTERN = /^[0-9a-f]{64}$/;
const DEFAULT_CHECK_INTERVAL_MS = 5 * 60_000;
const MIN_CHECK_INTERVAL_MS = 5_000;
const DEFAULT_AUTO_RELOAD_IDLE_MS = 30_000;
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "input", "focusin", "focusout", "scroll"] as const;
const UNSAFE_RELOAD_SELECTOR = [
  "dialog[open]",
  "[aria-modal=\"true\"]",
  "[data-supacloud-unsaved=\"true\"]",
  "[data-supacloud-busy=\"true\"]",
].join(",");

export interface FrontendReleasePointer {
  schema: typeof FRONTEND_RELEASE_POINTER_SCHEMA;
  release_id: string;
}

export interface FrontendReleaseUpdate {
  previousReleaseId: string;
  releaseId: string;
  pointer: FrontendReleasePointer;
}

export interface FrontendReleaseWatchOptions {
  /** Fetch implementation used to read the release pointer. */
  fetch?: typeof fetch;
  /** Release pointer URL. Defaults to the same-origin platform endpoint. */
  pointerUrl?: string;
  /** Poll interval. Use 0 to disable interval polling; values below 5s are clamped. */
  intervalMs?: number;
  /** Re-check when the browser window regains focus. Defaults to true. */
  checkOnFocus?: boolean;
  /** Re-check when the document becomes visible. Defaults to true. */
  checkOnVisibility?: boolean;
  /**
   * Automatic reload policy after a new release is observed.
   * - "safe" (default): reload immediately while hidden, otherwise after the
   *   page is idle and no editable field, modal, unsaved marker or busy marker
   *   is present.
   * - "hidden": reload only after the page becomes hidden.
   * - "never": only report the update.
   */
  autoReload?: "safe" | "hidden" | "never";
  /** Idle delay before a visible page reloads. Defaults to 30 seconds. */
  autoReloadIdleMs?: number;
  /** Override the final reload action (for tests or custom hosts). */
  reload?: () => void;
  /** Dispatch FRONTEND_UPDATE_EVENT on window after an update. Defaults to true. */
  dispatchEvent?: boolean;
  /** Called once for each newly observed release. */
  onUpdate?: (update: FrontendReleaseUpdate) => void;
  /** Called when a pointer read or validation fails. Polling continues. */
  onError?: (error: unknown) => void;
}

export interface FrontendReleaseWatcher {
  /** Check now; returns an update only when the release changed. */
  check(): Promise<FrontendReleaseUpdate | null>;
  /** Stop polling and remove browser listeners. */
  stop(): void;
  /** Release ID observed by the most recent successful check. */
  currentReleaseId(): string | null;
}

export function parseFrontendReleasePointer(value: unknown): FrontendReleasePointer {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Frontend release pointer is invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "release_id" || keys[1] !== "schema"
    || record["schema"] !== FRONTEND_RELEASE_POINTER_SCHEMA
    || typeof record["release_id"] !== "string"
    || !RELEASE_ID_PATTERN.test(record["release_id"])) {
    throw new Error("Frontend release pointer is invalid");
  }
  return {
    schema: FRONTEND_RELEASE_POINTER_SCHEMA,
    release_id: record["release_id"],
  };
}

export function watchFrontendRelease(options: FrontendReleaseWatchOptions = {}): FrontendReleaseWatcher {
  const pointerUrl = options.pointerUrl ?? FRONTEND_RELEASE_POINTER_PATH;
  const intervalMs = options.intervalMs === 0
    ? 0
    : Math.max(MIN_CHECK_INTERVAL_MS, options.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS);
  let currentReleaseId: string | null = null;
  let stopped = false;
  let inFlight: Promise<FrontendReleaseUpdate | null> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;

  async function readPointer(): Promise<FrontendReleasePointer> {
    const fetcher = options.fetch ?? globalThis.fetch;
    if (typeof fetcher !== "function") throw new Error("Frontend release check requires fetch");
    const response = await fetcher(pointerUrl, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Frontend release pointer returned HTTP ${response.status}`);
    return parseFrontendReleasePointer(await response.json());
  }

  function announce(update: FrontendReleaseUpdate): void {
    try {
      options.onUpdate?.(update);
    } catch (error) {
      options.onError?.(error);
    }
    if (options.dispatchEvent === false || typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(FRONTEND_UPDATE_EVENT, { detail: update }));
  }

  const autoReload = options.autoReload ?? "safe";
  const autoReloadIdleMs = Math.max(0, options.autoReloadIdleMs ?? DEFAULT_AUTO_RELOAD_IDLE_MS);
  let pendingUpdate: FrontendReleaseUpdate | null = null;
  let autoReloadTimer: ReturnType<typeof setTimeout> | null = null;
  let reloadRequested = false;

  function editableFocus(): boolean {
    if (typeof document === "undefined") return false;
    const active = document.activeElement as HTMLElement | null;
    return Boolean(active && (active.isContentEditable
      || active.tagName === "INPUT"
      || active.tagName === "TEXTAREA"
      || active.tagName === "SELECT"));
  }

  function canAutoReloadNow(): boolean {
    if (typeof document === "undefined") return false;
    if (document.visibilityState === "hidden") return true;
    if (editableFocus()) return false;
    return !document.querySelector(UNSAFE_RELOAD_SELECTOR);
  }

  function clearAutoReloadTimer(): void {
    if (autoReloadTimer === null) return;
    clearTimeout(autoReloadTimer);
    autoReloadTimer = null;
  }

  function stopWatcher(): void {
    stopped = true;
    if (interval !== null) {
      clearInterval(interval);
      interval = null;
    }
    if (typeof window !== "undefined" && options.checkOnFocus !== false) {
      window.removeEventListener("focus", scheduleCheck);
    }
    clearAutoReloadTimer();
    if (typeof document !== "undefined" && options.checkOnVisibility !== false) {
      document.removeEventListener("visibilitychange", visibilityHandler);
    }
    if (typeof document !== "undefined" && autoReload === "safe") {
      for (const eventName of ACTIVITY_EVENTS) document.removeEventListener(eventName, onActivity, true);
    }
  }

  function reloadNow(): void {
    if (reloadRequested || !pendingUpdate) return;
    reloadRequested = true;
    clearAutoReloadTimer();
    stopWatcher();
    const reload = options.reload ?? (() => {
      if (typeof window !== "undefined") window.location.reload();
    });
    reload();
  }

  function scheduleAutoReload(): void {
    if (autoReload === "never" || !pendingUpdate || reloadRequested || stopped) return;
    if (typeof document === "undefined") return;
    if (document.visibilityState === "hidden") {
      reloadNow();
      return;
    }
    if (autoReload === "hidden") return;
    clearAutoReloadTimer();
    if (!canAutoReloadNow()) return;
    autoReloadTimer = setTimeout(() => {
      autoReloadTimer = null;
      if (!pendingUpdate || !canAutoReloadNow()) return;
      reloadNow();
    }, autoReloadIdleMs);
  }

  function onActivity(): void {
    if (pendingUpdate) scheduleAutoReload();
  }

  async function performCheck(): Promise<FrontendReleaseUpdate | null> {
    if (stopped) return null;
    try {
      const pointer = await readPointer();
      if (stopped) return null;
      const previousReleaseId = currentReleaseId;
      currentReleaseId = pointer.release_id;
      if (previousReleaseId === null || previousReleaseId === pointer.release_id) return null;
      const update = { previousReleaseId, releaseId: pointer.release_id, pointer };
      pendingUpdate = update;
      announce(update);
      scheduleAutoReload();
      return update;
    } catch (error) {
      if (!stopped) options.onError?.(error);
      return null;
    }
  }

  function check(): Promise<FrontendReleaseUpdate | null> {
    if (inFlight) return inFlight;
    const pending = performCheck();
    inFlight = pending;
    void pending.finally(() => {
      if (inFlight === pending) inFlight = null;
    });
    return pending;
  }

  function scheduleCheck(): void {
    void check();
  }

  const visibilityHandler = () => {
    if (typeof document === "undefined") return;
    if (document.visibilityState === "visible") scheduleCheck();
    else scheduleAutoReload();
  };
  if (intervalMs > 0) interval = setInterval(scheduleCheck, intervalMs);
  if (typeof window !== "undefined" && options.checkOnFocus !== false) {
    window.addEventListener("focus", scheduleCheck);
  }
  if (typeof document !== "undefined" && options.checkOnVisibility !== false) {
    document.addEventListener("visibilitychange", visibilityHandler);
  }
  if (typeof document !== "undefined" && autoReload === "safe") {
    for (const eventName of ACTIVITY_EVENTS) document.addEventListener(eventName, onActivity, true);
  }

  // Establish the baseline immediately. A tab that starts on an old bundle
  // keeps that release ID and reports the next activation as an update.
  scheduleCheck();

  return {
    check,
    stop: stopWatcher,
    currentReleaseId() {
      return currentReleaseId;
    },
  };
}
