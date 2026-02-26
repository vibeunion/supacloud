/**
 * SupaCloud MCP Server – HTTP 传输层
 *
 * SupaCloud 安装完成后，通过 Management API (HTTP) 管理项目。
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

    /** 快速检测 API 是否可达 */
    async ping(): Promise<boolean> {
        const res = await this.get("/v1/projects").catch(() => null);
        return res?.ok ?? false;
    }
}
