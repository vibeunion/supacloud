import type { AuthProvider } from '@svadmin/core';
import { getStudioSession, loginStudio, logoutStudio } from '$lib/api';

export const authProvider: AuthProvider = {
  login: async ({ username, password }) => {
    const result = await loginStudio(String(username ?? ''), String(password ?? ''));
    if (result.success) {
      return {
        success: true,
        redirectTo: '/'
      };
    }
    
    return {
      success: false,
      error: new Error(result.error)
    };
  },
  
  logout: async () => {
    const result = await logoutStudio();
    if (!result.success) {
      return {
        success: false,
        error: new Error(result.error)
      };
    }
    return {
      success: true,
      redirectTo: '/login'
    };
  },
  
  check: async () => {
    try {
      const session = await getStudioSession();
      if (!session.authenticated) {
        return { authenticated: false, redirectTo: '/login' };
      }
      return { authenticated: true };
    } catch {
      return { authenticated: false, redirectTo: '/login' };
    }
  },
  
  getIdentity: async () => {
    try {
      const session = await getStudioSession();
      if (!session.authenticated) return null;
      return {
        id: session.username || 'admin',
        fullName: session.username || 'Super Admin',
        avatar: ''
      };
    } catch {
      return null;
    }
  },
  
  onError: async (error: unknown) => {
    const status = (error as { status?: number })?.status;
    if (status === 401 || status === 403) {
      return { logout: true, redirectTo: '/login' };
    }
    return {};
  }
};
