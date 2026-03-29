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
    },
    parseListResponse: (json: any, resource: string) => {
        if (json && (json.error || json.message)) {
            // Intercept application-level 200 OK errors (e.g. project paused) to prevent UI format crashing
            const msg = typeof json.error === "string" ? json.error : json.message;
            throw new Error(msg || "API Application Error");
        }
        if (Array.isArray(json)) return { data: json, total: json.length };
        if (json && Array.isArray(json.items)) return { data: json.items, total: json.total ?? json.items.length };
        if (json && Array.isArray(json.data)) return { data: json.data, total: json.total ?? json.data.length };
        if (json && json.rows && Array.isArray(json.rows)) return { data: json.rows, total: json.total ?? json.rows.length };
        throw new Error(`Unrecognized list response format from API for resource ${resource}. Expected { items, total }, { data, total }, or an array.`);
    }
});
