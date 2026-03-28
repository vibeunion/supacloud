import { createElysiaDataProvider } from '@svadmin/elysia';

const getApiUrl = () => {
    if (typeof window === 'undefined') return 'http://localhost:9090'; // SSR
    return window.location.origin;
};

export const dataProvider = createElysiaDataProvider({
    apiUrl: getApiUrl(),
    headers: (): Record<string, string> => {
        const token = typeof localStorage !== 'undefined' ? localStorage.getItem("supacloud_master_token") : null;
        if (token) {
            return {
                Authorization: `Bearer ${token}`
            };
        }
        return {};
    }
});
