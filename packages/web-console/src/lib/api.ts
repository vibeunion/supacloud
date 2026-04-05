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
  
  // Handle 401 Unauthorized globally by redirecting to login page
  if (response.status === 401 && typeof window !== 'undefined' && window.location.pathname !== '/login') {
    localStorage.removeItem("supacloud_session");
    localStorage.removeItem("supacloud_master_token");
    window.location.href = "/login";
  }
  
  return response;
}
