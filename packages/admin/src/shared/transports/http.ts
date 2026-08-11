/**
 * SupaCloud CLI HTTP transport layer.
 *
 * After SupaCloud is installed, manage projects via Management API (HTTP).
 * Includes request timeout, retry with exponential backoff, and proper error handling.
 */

export interface HttpConfig {
    baseUrl: string;
    token: string;
}

export interface HttpResult<T = unknown> {
    ok: boolean;
    status: number;
    data: T;
    transportError?: boolean;
}

interface HttpPostOptions {
    timeoutMs: number;
}

const DEFAULT_TIMEOUT = 30_000;
const MAX_POST_TIMEOUT_MS = 35 * 60_000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY = 500;

function isRetryableMethod(method?: string): boolean {
    const normalizedMethod = (method ?? "GET").toUpperCase();
    return normalizedMethod === "GET" || normalizedMethod === "HEAD";
}

function isRetryableError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const networkError = error as Error & { code?: string };
    return networkError.name === "AbortError"
        || networkError.code === "ECONNREFUSED"
        || networkError.code === "ECONNRESET";
}

function transportFailure<T>(error: unknown): HttpResult<T> {
    const networkError = error instanceof Error ? error as Error & { code?: string } : null;
    const code = networkError?.name === "AbortError"
        ? "TIMEOUT"
        : networkError?.code === "ECONNRESET" ? "CONNECTION_RESET" : "NETWORK_ERROR";
    return {
        ok: false,
        status: 500,
        data: { error: "Network Error", code } as T,
        transportError: true,
    };
}

function validatedPostTimeout(options?: HttpPostOptions): number {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_POST_TIMEOUT_MS) {
        throw new RangeError(`HTTP request timeout must be between 1 and ${MAX_POST_TIMEOUT_MS} ms`);
    }
    return timeoutMs;
}

async function fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs = DEFAULT_TIMEOUT,
): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchWithRetry(
    url: string,
    options: RequestInit,
    timeoutMs = DEFAULT_TIMEOUT,
): Promise<Response> {
    const retries = isRetryableMethod(options.method) ? MAX_RETRIES : 0;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetchWithTimeout(url, options, timeoutMs);

            if (res.status >= 500 && res.status < 600 && attempt < retries) {
                const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            return res;
        } catch (error: unknown) {
            if (attempt < retries && isRetryableError(error)) {
                const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw error;
        }
    }
    throw new Error("Unreachable");
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
        try {
            const res = await fetchWithRetry(`${this.baseUrl}${path}`, {
                method: "GET",
                headers: this.headers(),
            });
            const data = (await res.json().catch(() => null)) as T;
            return { ok: res.ok, status: res.status, data };
        } catch (error: unknown) {
            return transportFailure<T>(error);
        }
    }

    async post<T = unknown>(
        path: string,
        body?: unknown,
        options?: HttpPostOptions,
    ): Promise<HttpResult<T>> {
        const timeoutMs = validatedPostTimeout(options);
        try {
            const res = await fetchWithRetry(`${this.baseUrl}${path}`, {
                method: "POST",
                headers: this.headers(),
                body: body ? JSON.stringify(body) : undefined,
            }, timeoutMs);
            const data = (await res.json().catch(() => null)) as T;
            return { ok: res.ok, status: res.status, data };
        } catch (error: unknown) {
            return transportFailure<T>(error);
        }
    }

    async postMultipart<T = unknown>(path: string, formData: FormData): Promise<HttpResult<T>> {
        try {
            const headers = { Authorization: `Bearer ${this.token}` };
            const res = await fetchWithRetry(`${this.baseUrl}${path}`, {
                method: "POST",
                headers,
                body: formData,
            });
            const data = (await res.json().catch(() => null)) as T;
            return { ok: res.ok, status: res.status, data };
        } catch (error: unknown) {
            return transportFailure<T>(error);
        }
    }

    async patch<T = unknown>(path: string, body?: unknown): Promise<HttpResult<T>> {
        try {
            const res = await fetchWithRetry(`${this.baseUrl}${path}`, {
                method: "PATCH",
                headers: this.headers(),
                body: body ? JSON.stringify(body) : undefined,
            });
            const data = (await res.json().catch(() => null)) as T;
            return { ok: res.ok, status: res.status, data };
        } catch (error: unknown) {
            return transportFailure<T>(error);
        }
    }

    async put<T = unknown>(path: string, body?: unknown): Promise<HttpResult<T>> {
        try {
            const res = await fetchWithRetry(`${this.baseUrl}${path}`, {
                method: "PUT",
                headers: this.headers(),
                body: body ? JSON.stringify(body) : undefined,
            });
            const data = (await res.json().catch(() => null)) as T;
            return { ok: res.ok, status: res.status, data };
        } catch (error: unknown) {
            return transportFailure<T>(error);
        }
    }

    async delete<T = unknown>(path: string): Promise<HttpResult<T>> {
        try {
            const res = await fetchWithRetry(`${this.baseUrl}${path}`, {
                method: "DELETE",
                headers: this.headers(),
            });
            const data = (await res.json().catch(() => null)) as T;
            return { ok: res.ok, status: res.status, data };
        } catch (error: unknown) {
            return transportFailure<T>(error);
        }
    }

    async ping(): Promise<boolean> {
        const res = await this.get("/v1/projects").catch(() => null);
        return res?.ok ?? false;
    }
}
