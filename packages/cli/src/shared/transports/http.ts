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
    responseReadError?: true;
}

export interface HttpGetOptions {
    maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT = 30_000;
const RELEASE_MUTATION_RESPONSE_TIMEOUT = 5_000;
const RELEASE_MUTATION_RESPONSE_MAX_BYTES = 64 * 1024;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY = 500;

type ResponseBytesRead =
    | { ok: true; bytes: Uint8Array }
    | { ok: false };

type ResponseJsonRead<T = unknown> =
    | { ok: true; parsedJson: T }
    | { ok: false };

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

function responseReadFailure<T>(status: number): HttpResult<T> {
    return {
        ok: false,
        status,
        data: { error: "Response body unavailable", code: "RESPONSE_READ_ERROR" } as T,
        responseReadError: true,
    };
}

async function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal,
            redirect: "error",
        });
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchWithRetry(
    url: string,
    options: RequestInit,
): Promise<Response> {
    const retries = isRetryableMethod(options.method) ? MAX_RETRIES : 0;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetchWithTimeout(url, options);

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

function declaredResponseTooLarge(response: Response, maxBytes: number): boolean {
    const contentLength = response.headers.get("content-length");
    if (contentLength === null || !/^\d+$/.test(contentLength)) return false;
    return Number(contentLength) > maxBytes;
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

function cancelResponseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
    void reader.cancel().catch(() => undefined);
}

function serializedRequestBody(body: unknown): string | undefined {
    return body ? JSON.stringify(body) : undefined;
}

async function responseBytesFromReader(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    maxBytes: number,
    declaredBytes: number | null,
): Promise<ResponseBytesRead> {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            if (declaredBytes !== null && totalBytes !== declaredBytes) return { ok: false };
            return { ok: true, bytes: joinedResponseBytes(chunks, totalBytes) };
        }
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
            cancelResponseReader(reader);
            return { ok: false };
        }
        chunks.push(value);
    }
}

async function responseBytesWithinLimit(response: Response, maxBytes: number): Promise<Uint8Array | null> {
    if (declaredResponseTooLarge(response, maxBytes)) {
        await response.body?.cancel();
        return null;
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const bodyRead = await responseBytesFromReader(reader, maxBytes, null);
    return bodyRead.ok ? bodyRead.bytes : null;
}

function parsedUtf8Json(responseBytes: Uint8Array): ResponseJsonRead {
    try {
        const responseText = new TextDecoder("utf-8", { fatal: true }).decode(responseBytes);
        return { ok: true, parsedJson: JSON.parse(responseText) };
    } catch (error) {
        if (error instanceof SyntaxError || error instanceof TypeError) return { ok: false };
        throw error;
    }
}

async function boundedResponseJson(response: Response, maxBytes: number): Promise<unknown> {
    const responseBytes = await responseBytesWithinLimit(response, maxBytes);
    if (responseBytes === null) return null;
    const parsed = parsedUtf8Json(responseBytes);
    return parsed.ok ? parsed.parsedJson : null;
}

function declaredIdentityResponseBytes(response: Response): number | null | "invalid" {
    const contentEncoding = response.headers.get("content-encoding");
    if (contentEncoding !== null && contentEncoding.toLowerCase() !== "identity") return null;
    const contentLength = response.headers.get("content-length");
    if (contentLength === null) return null;
    if (!/^\d+$/.test(contentLength)) return "invalid";
    const declaredBytes = Number(contentLength);
    return Number.isSafeInteger(declaredBytes) ? declaredBytes : "invalid";
}

async function releaseMutationResponseBytes(response: Response): Promise<ResponseBytesRead> {
    const declaredBytes = declaredIdentityResponseBytes(response);
    if (declaredBytes === "invalid"
        || (declaredBytes !== null && declaredBytes > RELEASE_MUTATION_RESPONSE_MAX_BYTES)) {
        void response.body?.cancel().catch(() => undefined);
        return { ok: false };
    }
    if (!response.body) {
        return declaredBytes === null || declaredBytes === 0
            ? { ok: true, bytes: new Uint8Array() }
            : { ok: false };
    }
    return responseBytesBeforeDeadline(response.body.getReader(), declaredBytes);
}

async function responseBytesBeforeDeadline(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    declaredBytes: number | null,
): Promise<ResponseBytesRead> {
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<ResponseBytesRead>((resolve) => {
        deadlineTimer = setTimeout(() => {
            cancelResponseReader(reader);
            resolve({ ok: false });
        }, RELEASE_MUTATION_RESPONSE_TIMEOUT);
    });
    try {
        return await Promise.race([
            responseBytesFromReader(reader, RELEASE_MUTATION_RESPONSE_MAX_BYTES, declaredBytes),
            deadline,
        ]);
    } catch {
        // A body read failure cannot prove whether the server committed the mutation.
        cancelResponseReader(reader);
        return { ok: false };
    } finally {
        clearTimeout(deadlineTimer);
    }
}

async function releaseMutationResponseJson<T>(response: Response): Promise<ResponseJsonRead<T>> {
    const responseBytes = await releaseMutationResponseBytes(response);
    if (!responseBytes.ok) return { ok: false };
    const parsed = parsedUtf8Json(responseBytes.bytes);
    return parsed.ok ? { ok: true, parsedJson: parsed.parsedJson as T } : { ok: false };
}

async function responseJsonOrNull<T>(response: Response): Promise<ResponseJsonRead<T>> {
    return { ok: true, parsedJson: (await response.json().catch(() => null)) as T };
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

    private async postWithResponseReader<T>(
        path: string,
        serializedBody: string | undefined,
        responseReader: (response: Response) => Promise<ResponseJsonRead<T>>,
    ): Promise<HttpResult<T>> {
        try {
            const response = await fetchWithRetry(`${this.baseUrl}${path}`, {
                method: "POST",
                headers: this.headers(),
                body: serializedBody,
            });
            const responseBody = await responseReader(response);
            return responseBody.ok
                ? { ok: response.ok, status: response.status, data: responseBody.parsedJson }
                : responseReadFailure<T>(response.status);
        } catch (error: unknown) {
            return transportFailure<T>(error);
        }
    }

    async get<T = unknown>(path: string, options: HttpGetOptions = {}): Promise<HttpResult<T>> {
        try {
            const res = await fetchWithRetry(`${this.baseUrl}${path}`, {
                method: "GET",
                headers: this.headers(),
            });
            const data = (options.maxResponseBytes === undefined
                ? await res.json().catch(() => null)
                : await boundedResponseJson(res, options.maxResponseBytes)) as T;
            return { ok: res.ok, status: res.status, data };
        } catch (error: unknown) {
            return transportFailure<T>(error);
        }
    }

    async post<T = unknown>(path: string, body?: unknown): Promise<HttpResult<T>> {
        try {
            return await this.postWithResponseReader(path, serializedRequestBody(body), responseJsonOrNull<T>);
        } catch (error: unknown) {
            return transportFailure<T>(error);
        }
    }

    async postReleaseMutation<T = unknown>(path: string, body?: unknown): Promise<HttpResult<T>> {
        return this.postWithResponseReader(path, serializedRequestBody(body), releaseMutationResponseJson<T>);
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
