/**
 * Global API Client for SupaCloud Studio
 * Automatically attaches the master token for managed backend requests
 * and handles common error scenarios (e.g. 401 Unauthorized -> redirect to login).
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

function mergeAbortSignals(signals: Array<AbortSignal | null | undefined>): AbortSignal | undefined {
  const validSignals = signals.filter(Boolean) as AbortSignal[];
  if (validSignals.length === 0) return undefined;
  if (validSignals.length === 1) return validSignals[0];

  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };

  for (const signal of validSignals) {
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }

  return controller.signal;
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

export async function apiClient(url: string, options: RequestInit = {}): Promise<Response> {
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem("supacloud_session") : null;
  
  const headers = new Headers(options.headers || {});
  
  // Only inject Authorization if not already provided and if we have a token
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  
  // Set default Content-Type for JSON requests if body is stringified JSON
  if (options.body && typeof options.body === 'string' && options.body.startsWith('{') && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), DEFAULT_REQUEST_TIMEOUT_MS);
  const signal = mergeAbortSignals([options.signal, timeoutController.signal]);

  let response: Response;
  try {
    response = await fetch(url, { ...options, headers, signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      if (options.signal?.aborted && !timeoutController.signal.aborted) {
        throw error;
      }
      return new Response(JSON.stringify({
        message: "Request timeout",
        code: "TIMEOUT",
      }), {
        status: 504,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  response = await normalizeErrorResponse(response);
  
  // Handle 401 Unauthorized globally by redirecting to login page (with Race-Condition Pre-Flight check)
  if (response.status === 401 && typeof window !== 'undefined' && window.location.pathname !== '/login') {
    if (token) {
      try {
        // Pre-flight validation to see if the token is ACTUALLY gone 
        // (prevents kicks when another tab/process just refreshed it or temporary network hiccup)
        const verifyRes = await fetch('/auth/verify', {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token })
        });
        const verifyText = await verifyRes.text();
        const verifyData = verifyText ? JSON.parse(verifyText) : { valid: false };
        
        if (verifyData.valid) {
          // Token is actually still valid! Swallow the 401 logout to prevent false disconnect
          return response;
        }
      } catch (e) {
        // Fall through to logout
      }
    }
    
    // Truly expired
    localStorage.removeItem("supacloud_session");
    localStorage.removeItem("supacloud_master_token");
    window.location.href = "/login";
  }
  
  return response;
}
