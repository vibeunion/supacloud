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
    responseError?: boolean;
}

interface HttpPostOptions {
    timeoutMs: number;
}

export interface HttpGetOptions {
    maxResponseBytes?: number;
    maxJsonBytes?: number;
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

function responseBodyFailure<T>(status: number): HttpResult<T> {
    return {
        ok: false,
        status,
        data: { error: "Invalid Response", code: "INVALID_RESPONSE" } as T,
        responseError: true,
    };
}

function validatedPostTimeout(options?: HttpPostOptions): number {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_POST_TIMEOUT_MS) {
        throw new RangeError(`HTTP request timeout must be between 1 and ${MAX_POST_TIMEOUT_MS} ms`);
    }
    return timeoutMs;
}

function validatedGetResponseLimit(options: HttpGetOptions): number | undefined {
    const maxBytes = options.maxResponseBytes;
    if (maxBytes === undefined) return undefined;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new RangeError("HTTP response limit must be a positive safe integer");
    }
    return maxBytes;
}

function validatedStrictJsonLimit(options: HttpGetOptions): number | undefined {
    const maxBytes = options.maxJsonBytes;
    if (maxBytes === undefined) return undefined;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new RangeError("HTTP JSON response byte limit must be a positive safe integer");
    }
    return maxBytes;
}

function responseExceedsDeclaredLimit(response: Response, maxBytes: number): boolean {
    const contentLength = response.headers.get("content-length");
    return contentLength !== null && /^\d+$/u.test(contentLength) && Number(contentLength) > maxBytes;
}

function joinedResponseBytes(chunks: Uint8Array[], totalBytes: number): Uint8Array {
    const responseBytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        responseBytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return responseBytes;
}

async function boundedResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array | null> {
    if (responseExceedsDeclaredLimit(response, maxBytes)) {
        void response.body?.cancel().catch(() => undefined);
        return null;
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) return joinedResponseBytes(chunks, totalBytes);
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
            void reader.cancel().catch(() => undefined);
            return null;
        }
        chunks.push(value);
    }
}

async function boundedResponseJson(response: Response, maxBytes: number): Promise<unknown> {
    const responseBytes = await boundedResponseBytes(response, maxBytes);
    if (responseBytes === null) return null;
    try {
        const responseText = new TextDecoder("utf-8", { fatal: true }).decode(responseBytes);
        return JSON.parse(responseText);
    } catch (error: unknown) {
        if (error instanceof SyntaxError || error instanceof TypeError) return null;
        throw error;
    }
}

async function strictBoundedResponseJson(response: Response, maxBytes: number): Promise<unknown> {
    const responseBytes = await boundedResponseBytes(response, maxBytes);
    if (responseBytes === null) throw new Error("HTTP JSON response exceeded its byte limit");
    const responseText = new TextDecoder("utf-8", { fatal: true }).decode(responseBytes);
    return JSON.parse(responseText);
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
            redirect: "error",
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

    async get<T = unknown>(path: string, options: HttpGetOptions = {}): Promise<HttpResult<T>> {
        const maxResponseBytes = validatedGetResponseLimit(options);
        const maxJsonBytes = validatedStrictJsonLimit(options);
        if (maxResponseBytes !== undefined && maxJsonBytes !== undefined) {
            throw new RangeError("HTTP response limit options are mutually exclusive");
        }
        let response: Response;
        try {
            response = await fetchWithRetry(`${this.baseUrl}${path}`, {
                method: "GET",
                headers: this.headers(),
            });
        } catch (error: unknown) {
            return transportFailure<T>(error);
        }
        if (maxJsonBytes !== undefined) {
            try {
                const data = await strictBoundedResponseJson(response, maxJsonBytes) as T;
                return { ok: response.ok, status: response.status, data };
            } catch {
                return responseBodyFailure<T>(response.status);
            }
        }
        if (maxResponseBytes !== undefined) {
            const data = await boundedResponseJson(response, maxResponseBytes) as T;
            return { ok: response.ok, status: response.status, data };
        }
        const data = (await response.json().catch(() => null)) as T;
        return { ok: response.ok, status: response.status, data };
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
