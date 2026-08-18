/**
 * Global API Client for SupaCloud Studio
 * Uses the HttpOnly Studio session cookie for managed backend requests and
 * handles common error scenarios (e.g. 401 Unauthorized -> redirect to login).
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const SESSION_REFRESH_WINDOW_MS = 2 * 60 * 1000;
let studioSessionExpiresAtMs = 0;
let studioSessionRefreshPromise: Promise<StudioSessionState> | null = null;

export type StudioLoginResult =
  | { success: true; username?: string }
  | { success: false; error: string };

export type StudioLogoutResult =
  | { success: true }
  | { success: false; error: string };

export interface StudioSessionState {
  authenticated: boolean;
  username?: string;
  expiresAt?: string;
}

export interface ApiRequestInit extends RequestInit {
  timeoutMs?: number;
}

export async function ensureMutationSucceeded(response: Response, fallback: string): Promise<void> {
  const [payload, rawBody] = await Promise.all([
    readJsonObject(response.clone()),
    response.text().catch(() => ""),
  ]);
  if (response.ok && payload.success !== false) return;

  const message = typeof payload.message === "string"
    ? payload.message
    : typeof payload.error === "string"
      ? payload.error
      : rawBody.trim() || fallback;
  throw new Error(message);
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json().catch(() => ({}));
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function rememberStudioSessionExpiry(candidate: unknown): string | undefined {
  if (typeof candidate !== "string") return undefined;
  const timestamp = Date.parse(candidate);
  if (!Number.isFinite(timestamp)) return undefined;
  studioSessionExpiresAtMs = timestamp;
  return candidate;
}

function clearStudioSessionExpiry(): void {
  studioSessionExpiresAtMs = 0;
}

async function logoutErrorMessage(response: Response): Promise<string> {
  const [payload, rawBody] = await Promise.all([
    readJsonObject(response.clone()),
    response.text().catch(() => ""),
  ]);
  return typeof payload.error === "string"
    ? payload.error
    : typeof payload.message === "string"
      ? payload.message
      : rawBody.trim() || response.statusText || "Logout failed";
}

export async function loginStudio(username: string, password: string): Promise<StudioLoginResult> {
  const response = await fetch("/auth/login", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const data = await readJsonObject(response);
  if (response.ok && data.success === true) {
    rememberStudioSessionExpiry(data.expires_at);
    return {
      success: true,
      ...(typeof data.username === "string" ? { username: data.username } : {}),
    };
  }
  const message = typeof data.error === "string"
    ? data.error
    : typeof data.message === "string"
      ? data.message
      : "Login failed";
  return { success: false, error: message };
}

export async function getStudioSession(): Promise<StudioSessionState> {
  const response = await fetch("/auth/session", {
    method: "GET",
    credentials: "include",
    headers: { "Accept": "application/json" },
  });
  const data = await readJsonObject(response);
  const authenticated = response.ok && (data.valid === true || data.authenticated === true);
  const expiresAt = authenticated ? rememberStudioSessionExpiry(data.expires_at) : undefined;
  if (!authenticated) clearStudioSessionExpiry();
  return {
    authenticated,
    ...(authenticated && typeof data.username === "string" ? { username: data.username } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

export async function refreshStudioSession(): Promise<StudioSessionState> {
  const response = await fetch("/auth/refresh", {
    method: "POST",
    credentials: "include",
    headers: { "Accept": "application/json" },
  });
  const data = await readJsonObject(response);
  const authenticated = response.ok && data.success === true;
  const expiresAt = authenticated ? rememberStudioSessionExpiry(data.expires_at) : undefined;
  if (!authenticated) clearStudioSessionExpiry();
  return {
    authenticated,
    ...(authenticated && typeof data.username === "string" ? { username: data.username } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

export async function logoutStudio(): Promise<StudioLogoutResult> {
  const response = await fetch("/auth/logout", {
    method: "POST",
    credentials: "include",
    headers: { "Accept": "application/json" },
  });
  if (!response.ok) {
    return { success: false, error: await logoutErrorMessage(response) };
  }
  clearStudioSessionExpiry();
  return { success: true };
}

async function refreshExpiringStudioSession(): Promise<void> {
  if (
    typeof window === "undefined"
    || studioSessionExpiresAtMs === 0
    || studioSessionExpiresAtMs - Date.now() > SESSION_REFRESH_WINDOW_MS
  ) {
    return;
  }

  const refreshPromise = studioSessionRefreshPromise ??= refreshStudioSession();
  try {
    await refreshPromise;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    // 网络瞬断不应直接触发登出；原请求与后续 401 会话校验仍是最终依据。
  } finally {
    studioSessionRefreshPromise = null;
  }
}

function mergeAbortSignals(signals: Array<AbortSignal | null | undefined>): {
  signal: AbortSignal | undefined;
  cleanup: () => void;
} {
  const validSignals = signals.filter(Boolean) as AbortSignal[];
  if (validSignals.length === 0) return { signal: undefined, cleanup: () => {} };
  if (validSignals.length === 1) return { signal: validSignals[0], cleanup: () => {} };

  const controller = new AbortController();
  const listeningSignals: AbortSignal[] = [];
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };

  for (const signal of validSignals) {
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
    listeningSignals.push(signal);
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const signal of listeningSignals) signal.removeEventListener("abort", abort);
    },
  };
}

async function normalizeErrorResponse(response: Response): Promise<Response> {
  if (response.ok) return response;

  const contentType = response.headers.get("content-type") || "";
  const rawBody = await response.clone().text().catch(() => "");

  if (contentType.includes("application/json") && rawBody.trim().length > 0) {
    return response;
  }

  return new Response(JSON.stringify({
    message: rawBody.trim() || response.statusText || "Request failed",
    code: String(response.status || 500),
  }), {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function apiClient(url: string, options: ApiRequestInit = {}): Promise<Response> {
  await refreshExpiringStudioSession();
  const { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, ...requestInit } = options;
  const headers = new Headers(requestInit.headers || {});
  
  // Set default Content-Type for JSON requests if body is stringified JSON
  if (requestInit.body && typeof requestInit.body === 'string' && requestInit.body.startsWith('{') && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const timeoutController = timeoutMs === 0 ? null : new AbortController();
  const timeout = timeoutController
    ? setTimeout(() => timeoutController.abort(), timeoutMs)
    : undefined;
  const mergedSignal = mergeAbortSignals([requestInit.signal, timeoutController?.signal]);

  let response: Response;
  try {
    response = await fetch(url, {
      ...requestInit,
      headers,
      signal: mergedSignal.signal,
      credentials: requestInit.credentials ?? "include",
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      if (timeoutController?.signal.aborted) {
        return new Response(JSON.stringify({
          message: "Request timeout",
          code: "TIMEOUT",
        }), {
          status: 504,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    mergedSignal.cleanup();
  }

  response = await normalizeErrorResponse(response);
  
  // Recheck the cookie-backed session before redirecting on a transient 401.
  if (response.status === 401 && typeof window !== 'undefined' && window.location.pathname !== '/login') {
    try {
      const session = await getStudioSession();
      if (session.authenticated) {
        return response;
      }
    } catch {
      // Fall through to the login redirect.
    }
    window.location.href = "/login";
  }
  
  return response;
}
