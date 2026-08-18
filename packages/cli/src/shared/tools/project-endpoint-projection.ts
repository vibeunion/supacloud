import type { HttpResult } from "../transports/http";

export const PROJECT_ENDPOINT_PROJECTION_SCHEMA = "supacloud.project-endpoints.v1";

const PROJECT_REF_PATTERN = /^[a-z0-9-]{1,20}$/;
const PROJECT_STATUS_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const HOST_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const PROJECT_ENDPOINT_SOURCES = new Set(["explicit", "derived", "generated"]);
const PROJECT_ENDPOINT_STATUSES = new Set(["configured", "pending", "inactive", "unknown"]);
const PROJECT_ENDPOINT_VERIFICATION = "not_checked";
const PROJECT_ENDPOINT_KEYS = new Set([
    "origin", "host", "aliases", "source", "status", "verification",
]);
const PROJECT_ENDPOINT_PROJECTION_KEYS = new Set([
    "schema", "project_ref", "project_name", "project_status", "endpoints",
]);
const PROJECT_ENDPOINT_KINDS = new Set(["api", "auth", "studio"]);
const MAX_PROJECTS = 10_000;
const MAX_ENDPOINT_ALIASES = 128;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type ProjectEndpointReadResult = {
    text: string;
    isError: boolean;
};

type SafeProjectEndpoint = {
    origin: string;
    host: string;
    aliases: string[];
    source: "explicit" | "derived" | "generated";
    status: "configured" | "pending" | "inactive" | "unknown";
    verification: "not_checked";
};

type SafeProjectEndpointProjection = {
    schema: typeof PROJECT_ENDPOINT_PROJECTION_SCHEMA;
    project_ref: string;
    project_name: string;
    project_status: string;
    endpoints: {
        api: SafeProjectEndpoint;
        auth: SafeProjectEndpoint;
        studio: SafeProjectEndpoint;
    };
};

function plainRecord(candidate: unknown): Record<string, unknown> | null {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const prototype = Object.getPrototypeOf(candidate);
    return prototype === Object.prototype || prototype === null
        ? candidate as Record<string, unknown>
        : null;
}

function hasOnlyKeys(record: Record<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
    return Object.keys(record).every((key) => allowedKeys.has(key));
}

function hasWellFormedUnicode(text: string): boolean {
    for (let index = 0; index < text.length; index++) {
        const codeUnit = text.charCodeAt(index);
        if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
            if (index + 1 >= text.length) return false;
            const lowSurrogate = text.charCodeAt(index + 1);
            if (lowSurrogate < 0xDC00 || lowSurrogate > 0xDFFF) return false;
            index++;
        } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
            return false;
        }
    }
    return true;
}

function boundedText(candidate: unknown, maxLength: number): string | null {
    return typeof candidate === "string" && candidate.length > 0 && candidate.length <= maxLength
        && !/[\u0000-\u001f\u007f]/u.test(candidate) && hasWellFormedUnicode(candidate)
        ? candidate
        : null;
}

function matchingText(candidate: unknown, maxLength: number, pattern: RegExp): string | null {
    const text = boundedText(candidate, maxLength);
    return text && pattern.test(text) ? text : null;
}

function payloadWithinLimit(candidate: unknown): boolean {
    try {
        const serialized = JSON.stringify(candidate);
        return serialized !== undefined
            && new TextEncoder().encode(serialized).byteLength <= MAX_RESPONSE_BYTES;
    } catch {
        return false;
    }
}

function projectHost(candidate: unknown): string | null {
    const host = boundedText(candidate, 255);
    if (!host || host.trim() !== host || /[\\/@?#]/u.test(host)) return null;
    if (host.startsWith("[") && host.endsWith("]")) {
        try {
            const url = new URL(`http://${host}`);
            return url.host === host ? host : null;
        } catch {
            return null;
        }
    }
    const ipv4Parts = host.split(".");
    if (ipv4Parts.length === 4 && ipv4Parts.every((part) => /^\d{1,3}$/u.test(part))) {
        return ipv4Parts.every((part) => Number(part) <= 255) ? host : null;
    }
    return ipv4Parts.every((label) => HOST_LABEL_PATTERN.test(label)) ? host : null;
}

function projectEndpointAliases(candidate: unknown, primaryHost: string): string[] | null {
    if (!Array.isArray(candidate) || candidate.length > MAX_ENDPOINT_ALIASES) return null;
    const aliases: string[] = [];
    const seen = new Set<string>([primaryHost.toLowerCase()]);
    for (const aliasCandidate of candidate) {
        const alias = projectHost(aliasCandidate);
        if (!alias) return null;
        const normalized = alias.toLowerCase();
        if (seen.has(normalized)) return null;
        seen.add(normalized);
        aliases.push(alias);
    }
    return aliases;
}

function projectEndpointOrigin(candidate: unknown, expectedHost: string): string | null {
    const origin = boundedText(candidate, 2_048);
    if (!origin || origin.trim() !== origin || origin.includes("\\")) return null;
    try {
        const parsed = new URL(origin);
        if (!["http:", "https:"].includes(parsed.protocol)
            || parsed.username || parsed.password || parsed.search || parsed.hash
            || parsed.pathname !== "/"
            || parsed.hostname.toLowerCase() !== expectedHost.toLowerCase()) return null;
        return parsed.origin;
    } catch {
        return null;
    }
}

function safeProjectEndpoint(candidate: unknown): SafeProjectEndpoint | null {
    const endpoint = plainRecord(candidate);
    if (!endpoint || !hasOnlyKeys(endpoint, PROJECT_ENDPOINT_KEYS)) return null;
    const host = projectHost(endpoint.host);
    if (!host) return null;
    const origin = projectEndpointOrigin(endpoint.origin, host);
    const aliases = projectEndpointAliases(endpoint.aliases, host);
    if (!origin || !aliases
        || typeof endpoint.source !== "string" || !PROJECT_ENDPOINT_SOURCES.has(endpoint.source)
        || typeof endpoint.status !== "string" || !PROJECT_ENDPOINT_STATUSES.has(endpoint.status)
        || endpoint.verification !== PROJECT_ENDPOINT_VERIFICATION) return null;
    return {
        origin,
        host,
        aliases,
        source: endpoint.source as SafeProjectEndpoint["source"],
        status: endpoint.status as SafeProjectEndpoint["status"],
        verification: PROJECT_ENDPOINT_VERIFICATION,
    };
}

function safeProjectEndpointProjection(
    candidate: unknown,
    expectedRef?: string,
): SafeProjectEndpointProjection | null {
    if (!payloadWithinLimit(candidate)) return null;
    const projection = plainRecord(candidate);
    if (!projection || !hasOnlyKeys(projection, PROJECT_ENDPOINT_PROJECTION_KEYS)
        || projection.schema !== PROJECT_ENDPOINT_PROJECTION_SCHEMA) return null;
    const projectRef = matchingText(projection.project_ref, 20, PROJECT_REF_PATTERN);
    const projectName = boundedText(projection.project_name, 100);
    const projectStatus = matchingText(projection.project_status, 64, PROJECT_STATUS_PATTERN);
    const endpoints = plainRecord(projection.endpoints);
    if (!projectRef || (expectedRef && projectRef !== expectedRef) || !projectName || !projectStatus
        || !endpoints || !hasOnlyKeys(endpoints, PROJECT_ENDPOINT_KINDS)) return null;
    const api = safeProjectEndpoint(endpoints.api);
    const auth = safeProjectEndpoint(endpoints.auth);
    const studio = safeProjectEndpoint(endpoints.studio);
    if (!api || !auth || !studio) return null;
    return {
        schema: PROJECT_ENDPOINT_PROJECTION_SCHEMA,
        project_ref: projectRef,
        project_name: projectName,
        project_status: projectStatus,
        endpoints: { api, auth, studio },
    };
}

function validHttpStatus(status: number): boolean {
    return Number.isSafeInteger(status) && status >= 100 && status <= 599;
}

function successfulResponse(response: HttpResult<unknown>): boolean {
    return response.ok === true && validHttpStatus(response.status)
        && response.status >= 200 && response.status <= 299;
}

function failedResult(message: string): ProjectEndpointReadResult {
    return { text: `❌ ${message}`, isError: true };
}

function failedHttpResult(label: string, status: number): ProjectEndpointReadResult {
    return failedResult(validHttpStatus(status) ? `${label} request failed (${status})` : `${label} request failed`);
}

function success(
    payload: SafeProjectEndpointProjection | SafeProjectEndpointProjection[],
): ProjectEndpointReadResult {
    return { text: JSON.stringify(payload, null, 2), isError: false };
}

export function projectEndpointsRead(
    response: HttpResult<unknown>,
    expectedRef: string,
): ProjectEndpointReadResult {
    if (!successfulResponse(response)) return failedHttpResult("Project endpoints", response.status);
    const projection = safeProjectEndpointProjection(response.data, expectedRef);
    return projection ? success(projection) : failedResult("Invalid project endpoints response");
}

export function projectEndpointListRead(response: HttpResult<unknown>): ProjectEndpointReadResult {
    if (!successfulResponse(response)) return failedHttpResult("Project endpoint list", response.status);
    if (!payloadWithinLimit(response.data) || !Array.isArray(response.data) || response.data.length > MAX_PROJECTS) {
        return failedResult("Invalid project endpoint list response");
    }
    const projections: SafeProjectEndpointProjection[] = [];
    const refs = new Set<string>();
    for (const candidate of response.data) {
        const projection = safeProjectEndpointProjection(candidate);
        if (!projection || refs.has(projection.project_ref)) {
            return failedResult("Invalid project endpoint list response");
        }
        refs.add(projection.project_ref);
        projections.push(projection);
    }
    return success(projections);
}
