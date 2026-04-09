/**
 * Global API Client for SupaCloud Studio
 * Automatically attaches the master token for managed backend requests
 * and handles common error scenarios (e.g. 401 Unauthorized -> redirect to login).
 */

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

  const response = await fetch(url, { ...options, headers });
  
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
        const verifyData = await verifyRes.json();
        
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
