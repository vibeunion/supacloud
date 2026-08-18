import type { HttpResult } from "../transports/http";

export const PROJECT_ENDPOINT_RESPONSE_MAX_BYTES = 256 * 1024;
export const PROJECT_ENDPOINT_LIST_RESPONSE_MAX_BYTES = 1024 * 1024;

const PROJECT_REF_PATTERN = /^[a-z0-9-]{1,20}$/;
const PROJECT_ENDPOINTS_SCHEMA = "supacloud.project-endpoints.v1";
const PROJECT_ENDPOINT_SOURCES = new Set([
    "explicit_api_domain",
    "explicit_auth_domain",
    "explicit_studio_domain",
    "custom_domain",
    "derived_api_domain",
    "generated",
]);
const ROOT_KEYS = new Set(["schema", "project_ref", "endpoints"]);
const ENDPOINTS_KEYS = new Set(["api", "auth", "studio"]);
const ENDPOINT_KEYS = new Set(["origin", "host", "scheme", "source", "aliases"]);
const MAX_PROJECTS = 10_000;
const MAX_ALIASES = 64;

export type ProjectEndpointReadResult = {
    text: string;
    isError: boolean;
};

type SafeProjectEndpoint = {
    origin: string;
    host: string;
    scheme: "http" | "https";
    source: string;
    aliases: string[];
};

type SafeProjectEndpointProjection = {
    schema: typeof PROJECT_ENDPOINTS_SCHEMA;
    project_ref: string;
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

function boundedText(candidate: unknown, maxLength: number): string | null {
    return typeof candidate === "string"
        && candidate.length > 0
        && candidate.length <= maxLength
        && !/[\u0000-\u001f\u007f]/u.test(candidate)
        ? candidate
        : null;
}

function canonicalHost(candidate: unknown, scheme: "http" | "https"): string | null {
    const host = boundedText(candidate, 255);
    if (!host) return null;
    try {
        const parsed = new URL(`${scheme}://${host}`);
        return parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash
            || parsed.host !== host
            ? null
            : host;
    } catch {
        return null;
    }
}

function projectEndpoint(candidate: unknown): SafeProjectEndpoint | null {
    const endpoint = plainRecord(candidate);
    if (!endpoint || !hasOnlyKeys(endpoint, ENDPOINT_KEYS)) return null;
    const scheme = endpoint.scheme === "http" || endpoint.scheme === "https"
        ? endpoint.scheme
        : null;
    const origin = boundedText(endpoint.origin, 2_048);
    const source = boundedText(endpoint.source, 64);
    if (!scheme || !origin || !source || !PROJECT_ENDPOINT_SOURCES.has(source)) return null;

    let parsedOrigin: URL;
    try {
        parsedOrigin = new URL(origin);
    } catch {
        return null;
    }
    if (parsedOrigin.protocol !== `${scheme}:`
        || parsedOrigin.origin !== origin
        || parsedOrigin.username
        || parsedOrigin.password
        || parsedOrigin.pathname !== "/"
        || parsedOrigin.search
        || parsedOrigin.hash) return null;

    const host = canonicalHost(endpoint.host, scheme);
    if (!host || host !== parsedOrigin.host || !Array.isArray(endpoint.aliases)
        || endpoint.aliases.length > MAX_ALIASES) return null;

    const aliases: string[] = [];
    const seenAliases = new Set<string>();
    for (const aliasCandidate of endpoint.aliases) {
        const alias = canonicalHost(aliasCandidate, scheme);
        if (!alias || alias === host || seenAliases.has(alias)) return null;
        seenAliases.add(alias);
        aliases.push(alias);
    }

    return { origin, host, scheme, source, aliases };
}

function projectEndpointProjection(candidate: unknown): SafeProjectEndpointProjection | null {
    const projection = plainRecord(candidate);
    if (!projection || !hasOnlyKeys(projection, ROOT_KEYS)
        || projection.schema !== PROJECT_ENDPOINTS_SCHEMA
        || typeof projection.project_ref !== "string"
        || !PROJECT_REF_PATTERN.test(projection.project_ref)) return null;

    const endpoints = plainRecord(projection.endpoints);
    if (!endpoints || !hasOnlyKeys(endpoints, ENDPOINTS_KEYS)) return null;
    const api = projectEndpoint(endpoints.api);
    const auth = projectEndpoint(endpoints.auth);
    const studio = projectEndpoint(endpoints.studio);
    return api && auth && studio
        ? {
            schema: PROJECT_ENDPOINTS_SCHEMA,
            project_ref: projection.project_ref,
            endpoints: { api, auth, studio },
        }
        : null;
}

function validHttpStatus(status: number): boolean {
    return Number.isSafeInteger(status) && status >= 100 && status <= 599;
}

function successfulResponse(response: HttpResult<unknown>): boolean {
    return response.ok === true
        && validHttpStatus(response.status)
        && response.status >= 200
        && response.status <= 299;
}

function failedResult(message: string): ProjectEndpointReadResult {
    return { text: `❌ ${message}`, isError: true };
}

function failedHttpResult(label: string, status: number): ProjectEndpointReadResult {
    return failedResult(validHttpStatus(status) ? `${label} request failed (${status})` : `${label} request failed`);
}

function successfulResult(payload: SafeProjectEndpointProjection | SafeProjectEndpointProjection[]): ProjectEndpointReadResult {
    return { text: JSON.stringify(payload, null, 2), isError: false };
}

export function projectEndpointRead(
    response: HttpResult<unknown>,
    expectedRef: string,
): ProjectEndpointReadResult {
    if (!successfulResponse(response)) return failedHttpResult("Project endpoints", response.status);
    const projection = projectEndpointProjection(response.data);
    return projection && projection.project_ref === expectedRef
        ? successfulResult(projection)
        : failedResult("Invalid project endpoint response");
}

export function projectEndpointListRead(response: HttpResult<unknown>): ProjectEndpointReadResult {
    if (!successfulResponse(response)) return failedHttpResult("Project endpoint list", response.status);
    if (!Array.isArray(response.data) || response.data.length > MAX_PROJECTS) {
        return failedResult("Invalid project endpoint list response");
    }

    const projections: SafeProjectEndpointProjection[] = [];
    const refs = new Set<string>();
    for (const candidate of response.data) {
        const projection = projectEndpointProjection(candidate);
        if (!projection || refs.has(projection.project_ref)) {
            return failedResult("Invalid project endpoint list response");
        }
        refs.add(projection.project_ref);
        projections.push(projection);
    }
    return successfulResult(projections);
}
