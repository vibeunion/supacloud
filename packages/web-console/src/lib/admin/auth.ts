import type { AuthProvider } from '@svadmin/core';

export const authProvider: AuthProvider = {
  login: async ({ username, password }) => {
    const res = await fetch('/auth/login', {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    
    const data = await res.json();
    if (data.success && data.token && data.masterToken) {
      localStorage.setItem("supacloud_session", data.token);
      localStorage.setItem("supacloud_master_token", data.masterToken);
      
      return {
        success: true,
        redirectTo: '/'
      };
    }
    
    return {
      success: false,
      error: new Error(data.error || "Login failed")
    };
  },
  
  logout: async () => {
    localStorage.removeItem("supacloud_session");
    localStorage.removeItem("supacloud_master_token");
    return {
      success: true,
      redirectTo: '/login'
    };
  },
  
  check: async () => {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem("supacloud_session") : null;
    if (!token) {
      return { authenticated: false, redirectTo: '/login' };
    }
    
    try {
      const res = await fetch('/auth/verify', {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token })
      });
      const data = await res.json();
      if (!data.valid) {
        localStorage.removeItem("supacloud_session");
        localStorage.removeItem("supacloud_master_token");
        return { authenticated: false, redirectTo: '/login' };
      }
      return { authenticated: true };
    } catch {
      return { authenticated: false, redirectTo: '/login' };
    }
  },
  
  getIdentity: async () => {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem("supacloud_session") : null;
    if (!token) return null;
    
    try {
      const [payloadB64] = token.split(".");
      const payload = JSON.parse(atob(payloadB64));
      return {
        id: payload.user || 'admin',
        fullName: 'Super Admin',
        avatar: ''
      };
    } catch {
      return null;
    }
  },
  
  onError: async (error: any) => {
    if (error?.status === 401 || error?.status === 403) {
      return { logout: true, redirectTo: '/login' };
    }
    return {};
  }
};
