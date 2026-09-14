/**
 * Global API Client for SupaCloud Studio
 * Uses the HttpOnly Studio session cookie for managed backend requests and
 * handles common error scenarios (e.g. 401 Unauthorized -> redirect to login).
 */

import { readBoundedText } from "./http-body";
import { requestValidatedJson } from "./validated-json";
import {
  InvalidStudioSessionResponse, parseStudioLogout, parseStudioSession, studioLoginFailure,
  type StudioLoginResult, type StudioLogoutResult, type StudioSessionState,
} from "./studio-session-contract";
export type { StudioLoginResult, StudioLogoutResult, StudioSessionState } from "./studio-session-contract";

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const SESSION_REFRESH_WINDOW_MS = 2 * 60 * 1000;
let studioSessionExpiresAtMs: number = 0;
let studioSessionGeneration = 0;
type StudioSessionRefresh = { promise: Promise<StudioSessionState>; generation: number };
let studioSessionRefresh: StudioSessionRefresh | null = null;

class StudioSessionChanged extends Error {
  constructor() { super("Studio session changed during the request"); }
}

class MutationResponseError extends Error {}

export interface ApiRequestInit extends RequestInit {
  timeoutMs?: number;
}

export async function ensureMutationSucceeded(
  response: Response, fallback: string, decode?: (value: unknown) => void,
  options: Pick<RequestInit, "signal"> = {},
): Promise<void> {
  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  try {
    signal.throwIfAborted();
    if (response.status === 204) {
      if (decode === undefined) return;
      throw new Error(fallback);
    }

    const rawBody = await readBoundedText(response, 8 * 1024 * 1024, signal);
    if (!rawBody.trim()) throw new Error(fallback);

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      if (!response.ok) throw new MutationResponseError(rawBody.trim() || fallback);
      throw new Error(fallback);
    }

    if (!response.ok) throw new MutationResponseError(mutationErrorMessage(payload, fallback));
    if (isMutationFailure(payload)) throw new MutationResponseError(mutationErrorMessage(payload, fallback));
    try {
      decode?.(payload);
    } catch {
      throw new Error(fallback);
    }
  } catch (error) {
    signal.throwIfAborted();
    throw error instanceof MutationResponseError ? error : new Error(fallback);
  } finally {
    void response.body?.cancel().catch(() => {});
  }
}

function isMutationFailure(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.hasOwn(value, "success") && (value as { success?: unknown }).success === false;
}

function mutationErrorMessage(value: unknown, fallback: string): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const data = value as { message?: unknown; error?: unknown };
    if (typeof data.message === "string" && data.message.trim()) return data.message;
    if (typeof data.error === "string" && data.error.trim()) return data.error;
  }
  return fallback;
}

function requireStudioSessionGeneration(generation: number): void {
  if (generation !== studioSessionGeneration) throw new StudioSessionChanged();
}

function applyStudioSession(session: StudioSessionState, generation: number): void {
  requireStudioSessionGeneration(generation);
  studioSessionExpiresAtMs = session.authenticated ? Date.parse(session.expiresAt) : 0;
}

function clearStudioSessionExpiry(): void {
  studioSessionExpiresAtMs = 0;
}

async function requestStudioSession<T>(
  path: string,
  options: RequestInit,
  decode: (value: unknown, status: number) => T,
): Promise<T> {
  let received = false;
  try {
    return await requestValidatedJson(path, async (url, init) => {
      const response = await fetch(url, init);
      received = true;
      return response;
    }, decode, { ...options, credentials: "include", cache: "no-store" },
    { statuses: [200, 401, 403, 429], maxBytes: 64 * 1024 });
  } catch (error) {
    if (!received || error instanceof StudioSessionChanged
      || (error instanceof DOMException && error.name === "AbortError")) throw error;
    throw new InvalidStudioSessionResponse();
  }
}

export async function loginStudio(
  username: string, password: string, options: Pick<RequestInit, "signal"> = {},
): Promise<StudioLoginResult> {
  if (typeof username !== "string" || !username.trim() || username.length > 320
    || typeof password !== "string" || !password.length || password.length > 4096) {
    throw new Error("Invalid Studio login input");
  }
  const generation = ++studioSessionGeneration;
  return requestStudioSession("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ username, password }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }, (value, status) => {
    const session = parseStudioSession(value, status, "login");
    applyStudioSession(session, generation);
    return session.authenticated
      ? { success: true, username: session.username }
      : { success: false, error: studioLoginFailure(status) };
  });
}

export async function getStudioSession(options: Pick<RequestInit, "signal"> = {}): Promise<StudioSessionState> {
  const generation = studioSessionGeneration;
  return requestStudioSession("/auth/session", {
    method: "GET",
    headers: { "Accept": "application/json" },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }, (value, status) => {
    const session = parseStudioSession(value, status, "session");
    applyStudioSession(session, generation);
    return session;
  });
}

export async function refreshStudioSession(options: Pick<RequestInit, "signal"> = {}): Promise<StudioSessionState> {
  const generation = studioSessionGeneration;
  try {
    return await requestStudioSession("/auth/refresh", {
      method: "POST",
      headers: { "Accept": "application/json" },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, (value, status) => {
      const session = parseStudioSession(value, status, "refresh");
      applyStudioSession(session, generation);
      return session;
    });
  } catch (error) {
    // An uncertain rotation must not be retried by the next automatic refresh.
    if (generation === studioSessionGeneration) clearStudioSessionExpiry();
    throw error;
  }
}

export async function logoutStudio(options: Pick<RequestInit, "signal"> = {}): Promise<StudioLogoutResult> {
  const generation = ++studioSessionGeneration;
  const response = await fetch("/auth/logout", {
    method: "POST",
    headers: { "Accept": "application/json" },
    credentials: "include",
    cache: "no-store",
    redirect: "error",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  requireStudioSessionGeneration(generation);

  const signal = options.signal ?? new AbortController().signal;
  const rawBody = await readBoundedText(response, 64 * 1024, signal);
  let payload: unknown;
  try {
    payload = rawBody.trim() ? JSON.parse(rawBody) : {};
  } catch {
    payload = rawBody.trim();
  }

  if (response.ok) {
    const result = parseStudioLogout(payload, response.status);
    if (result.success) clearStudioSessionExpiry();
    return result;
  }
  if (response.status === 403 && payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    return parseStudioLogout(payload, response.status);
  }
  return { success: false, error: mutationErrorMessage(payload, rawBody.trim() || "Logout failed") };
}

async function refreshExpiringStudioSession(): Promise<void> {
  if (
    typeof window === "undefined"
    || studioSessionExpiresAtMs === 0
    || studioSessionExpiresAtMs - Date.now() > SESSION_REFRESH_WINDOW_MS
  ) {
    return;
  }

  const refresh = studioSessionRefresh?.generation === studioSessionGeneration
    ? studioSessionRefresh
    : (studioSessionRefresh = { promise: refreshStudioSession(), generation: studioSessionGeneration });
  try {
    await refresh.promise;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    // Network hiccups should not directly trigger logout; the original request and subsequent 401 session checks remain authoritative.
  } finally {
    if (studioSessionRefresh === refresh) {
      studioSessionRefresh = null;
    }
  }
}

function validateManagedUrl(url: string): void {
  if (typeof url !== "string" || /[\u0000-\u0020\u007f\\#]/.test(url)) throw new TypeError("Invalid API URL");
  if (url.startsWith("/") && !url.startsWith("//")) return;
  if (typeof window === "undefined") throw new TypeError("Invalid API URL");
  const parsed = new URL(url);
  const origin = new URL(window.location.href).origin;
  if (!/^https?:$/.test(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) {
    throw new TypeError("Invalid API URL");
  }
}

async function normalizeErrorResponse(response: Response, signal: AbortSignal): Promise<Response> {
  if (response.ok) return response;
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  let payload: unknown;
  if (contentType === "application/json" || /^application\/[a-z0-9.+-]+\+json$/.test(contentType ?? "")) {
    try {
      payload = JSON.parse(await readBoundedText(response, 64 * 1024, signal));
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
    } catch {
      signal.throwIfAborted();
      throw new Error("Invalid API error response");
    }
  } else {
    void response.body?.cancel().catch(() => {});
    const messages: Record<number, string> = {
      400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
      409: "Conflict", 429: "Too Many Requests", 500: "Internal Server Error",
      502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
    };
    payload = { message: messages[response.status] ?? "Request failed", code: String(response.status) };
  }
  const headers = new Headers(response.headers);
  for (const name of ["content-length", "content-encoding", "transfer-encoding", "etag", "content-md5", "digest"]) {
    headers.delete(name);
  }
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(payload), { status: response.status, headers });
}

export async function apiClient(url: string, options: ApiRequestInit = {}): Promise<Response> {
  const generation = studioSessionGeneration;
  const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, ...requestInit } = options;
  validateManagedUrl(url);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    throw new TypeError("Invalid API timeout");
  }
  const headers = new Headers(requestInit.headers || {});
  requestInit.signal?.throwIfAborted();
  
  // Set default Content-Type for JSON requests if body is stringified JSON
  if (requestInit.body && typeof requestInit.body === 'string' && requestInit.body.startsWith('{') && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const controller = new AbortController();
  const stopped = Promise.withResolvers<never>();
  const timeoutReason = new DOMException("Request timeout", "TimeoutError");
  const abort = () => controller.abort(requestInit.signal?.reason);
  const stop = () => stopped.reject(controller.signal.reason);
  controller.signal.addEventListener("abort", stop, { once: true });
  requestInit.signal?.addEventListener("abort", abort, { once: true });
  const timeout = timeoutMs === 0 ? undefined : setTimeout(() => controller.abort(timeoutReason), timeoutMs);
  // The native dependent signal keeps caller cancellation connected to successful
  // response streams after the workflow listener and deadline are removed.
  const signal = requestInit.signal
    ? AbortSignal.any([requestInit.signal, controller.signal])
    : controller.signal;
  const check = () => {
    signal.throwIfAborted();
    requireStudioSessionGeneration(generation);
  };
  const workflow = Promise.resolve().then(async () => {
    check();
    await refreshExpiringStudioSession();
    check();
    let response = await fetch(url, {
      ...requestInit,
      headers,
      signal,
      redirect: "error",
      credentials: requestInit.credentials ?? "include",
    });
    try {
      check();
      if (response.redirected || response.status < 200 || response.status >= 300 && response.status < 400) {
        throw new Error("Invalid API response");
      }
      response = await normalizeErrorResponse(response, signal);
      check();
      if (response.status === 401 && typeof window !== "undefined" && window.location.pathname !== "/login") {
        try {
          const session = await getStudioSession({ signal });
          check();
          if (session.authenticated) return response;
        } catch {
          check();
          // Fall through to the login redirect only while this operation is current.
        }
        window.location.href = "/login";
      }
      return response;
    } catch (error) {
      void response.body?.cancel().catch(() => {});
      throw error;
    }
  });
  try {
    return await Promise.race([workflow, stopped.promise]);
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason === timeoutReason) {
      return Response.json({ message: "Request timeout", code: "TIMEOUT" }, { status: 504 });
    }
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    requestInit.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", stop);
  }
}
