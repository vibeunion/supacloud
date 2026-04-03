/**
 * SupaCloud MCP Server – HTTP Transport Layer
 *
 * After SupaCloud is installed, manage projects via Management API (HTTP).
 */

export interface HttpConfig {
    baseUrl: string;
    token: string;
}

export interface HttpResult<T = unknown> {
    ok: boolean;
    status: number;
    data: T;
}

export class HttpTransport {
    private baseUrl: string;
    private token: string;

    constructor(config: HttpConfig) {
        this.baseUrl = config.baseUrl.replace(/\/$/, "");
        this.token = config.token;
    }

    private headers(): Record<string, string> {
        return {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
        };
    }

    async get<T = unknown>(path: string): Promise<HttpResult<T>> {
        const res = await fetch(`${this.baseUrl}${path}`, {
            method: "GET",
            headers: this.headers(),
        });
        const data = (await res.json().catch(() => null)) as T;
        return { ok: res.ok, status: res.status, data };
    }

    async post<T = unknown>(path: string, body?: unknown): Promise<HttpResult<T>> {
        const res = await fetch(`${this.baseUrl}${path}`, {
            method: "POST",
            headers: this.headers(),
            body: body ? JSON.stringify(body) : undefined,
        });
        const data = (await res.json().catch(() => null)) as T;
        return { ok: res.ok, status: res.status, data };
    }

    async postMultipart<T = unknown>(path: string, formData: FormData): Promise<HttpResult<T>> {
        const headers = { Authorization: `Bearer ${this.token}` };
        const res = await fetch(`${this.baseUrl}${path}`, {
            method: "POST",
            headers,
            body: formData,
        });
        const data = (await res.json().catch(() => null)) as T;
        return { ok: res.ok, status: res.status, data };
    }

    async patch<T = unknown>(path: string, body?: unknown): Promise<HttpResult<T>> {
        const res = await fetch(`${this.baseUrl}${path}`, {
            method: "PATCH",
            headers: this.headers(),
            body: body ? JSON.stringify(body) : undefined,
        });
        const data = (await res.json().catch(() => null)) as T;
        return { ok: res.ok, status: res.status, data };
    }

    async put<T = unknown>(path: string, body?: unknown): Promise<HttpResult<T>> {
        const res = await fetch(`${this.baseUrl}${path}`, {
            method: "PUT",
            headers: this.headers(),
            body: body ? JSON.stringify(body) : undefined,
        });
        const data = (await res.json().catch(() => null)) as T;
        return { ok: res.ok, status: res.status, data };
    }

    async delete<T = unknown>(path: string): Promise<HttpResult<T>> {
        const res = await fetch(`${this.baseUrl}${path}`, {
            method: "DELETE",
            headers: this.headers(),
        });
        const data = (await res.json().catch(() => null)) as T;
        return { ok: res.ok, status: res.status, data };
    }

    /** Quick check if API is reachable */
    async ping(): Promise<boolean> {
        const res = await this.get("/v1/projects").catch(() => null);
        return res?.ok ?? false;
    }
}
