import type { HttpResult } from "../transports/http";

export const PROJECT_READ_RESPONSE_MAX_BYTES = 1_048_576;

const PROJECT_REF_PATTERN = /^[a-z0-9-]{1,20}$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const REGION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const STATUS_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const DNS_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const DATABASE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const MAX_PROJECTS = 10_000;

const PROJECT_SUMMARY_KEYS = new Set([
    "id", "ref", "organization_id", "organization_slug",
    "name", "region", "created_at", "status",
]);
const PROJECT_DETAILS_KEYS = new Set([
    ...PROJECT_SUMMARY_KEYS,
    "database", "api", "studio", "config", "anon_key", "services",
]);
const PROJECT_DATABASE_KEYS = new Set([
    "host", "version", "postgres_engine", "release_channel",
]);
const PROJECT_ENDPOINT_KEYS = new Set(["url"]);

export type ProjectReadResult = {
    text: string;
    isError: boolean;
};

interface SafeProjectSummary {
    id: string;
    ref: string;
    organization_id: string;
    organization_slug: string;
    name: string;
    region: string;
    created_at: string;
    status: string;
}

interface SafeProjectDetails extends SafeProjectSummary {
    database: {
        host: string;
        version: string;
        postgres_engine: string;
        release_channel: string;
    };
    api?: { url: string };
    studio?: { url: string };
}

function plainRecord(candidate: unknown): Record<string, unknown> | null {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const prototype = Object.getPrototypeOf(candidate);
    return prototype === Object.prototype || prototype === null
        ? candidate as Record<string, unknown>
        : null;
}

function hasOnlyKeys(record: Record<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
    return Object.keys(record).every(key => allowedKeys.has(key));
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
    const candidateText = boundedText(candidate, maxLength);
    return candidateText && pattern.test(candidateText) ? candidateText : null;
}

function canonicalTimestamp(candidate: unknown): string | null {
    const timestamp = boundedText(candidate, 64);
    if (!timestamp) return null;
    const milliseconds = Date.parse(timestamp);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === timestamp
        ? timestamp
        : null;
}

function projectedSummary(project: Record<string, unknown>): SafeProjectSummary | null {
    const summary = {
        id: matchingText(project.id, 128, SAFE_IDENTIFIER_PATTERN),
        ref: matchingText(project.ref, 20, PROJECT_REF_PATTERN),
        organization_id: matchingText(project.organization_id, 128, SAFE_IDENTIFIER_PATTERN),
        organization_slug: matchingText(project.organization_slug, 128, SAFE_IDENTIFIER_PATTERN),
        name: boundedText(project.name, 100),
        region: matchingText(project.region, 64, REGION_PATTERN),
        created_at: canonicalTimestamp(project.created_at),
        status: matchingText(project.status, 64, STATUS_PATTERN),
    };
    return Object.values(summary).every(field => field !== null)
        ? summary as SafeProjectSummary
        : null;
}

function projectSummary(candidate: unknown): SafeProjectSummary | null {
    const project = plainRecord(candidate);
    return project && hasOnlyKeys(project, PROJECT_SUMMARY_KEYS)
        ? projectedSummary(project)
        : null;
}

function databaseHost(candidate: unknown): string | null {
    const host = boundedText(candidate, 255);
    if (!host) return null;
    if (host.startsWith("[") && host.endsWith("]")) {
        try {
            const parsedHost = new URL(`http://${host}`);
            return parsedHost.host === host ? host : null;
        } catch (error: unknown) {
            if (error instanceof TypeError) return null;
            throw error;
        }
    }
    const ipv4Parts = host.split(".");
    if (ipv4Parts.length === 4 && ipv4Parts.every(part => /^\d{1,3}$/u.test(part))) {
        return ipv4Parts.every(part => Number(part) <= 255) ? host : null;
    }
    return ipv4Parts.every(label => DNS_LABEL_PATTERN.test(label)) ? host : null;
}

function projectDatabase(candidate: unknown): SafeProjectDetails["database"] | null {
    const database = plainRecord(candidate);
    if (!database || !hasOnlyKeys(database, PROJECT_DATABASE_KEYS)) return null;
    const host = databaseHost(database.host);
    const version = matchingText(database.version, 64, DATABASE_VERSION_PATTERN);
    const postgresEngine = matchingText(database.postgres_engine, 64, DATABASE_VERSION_PATTERN);
    const releaseChannel = matchingText(database.release_channel, 64, DATABASE_VERSION_PATTERN);
    return host && version && postgresEngine && releaseChannel
        ? { host, version, postgres_engine: postgresEngine, release_channel: releaseChannel }
        : null;
}

function rawUrlHasNoPath(candidate: string): boolean {
    if (candidate.trim() !== candidate || candidate.includes("\\")) return false;
    const schemeEnd = candidate.indexOf("://");
    const pathStart = candidate.indexOf("/", schemeEnd + 3);
    return pathStart === -1;
}

function projectEndpoint(candidate: unknown): { url: string } | null {
    const endpoint = plainRecord(candidate);
    if (!endpoint || !hasOnlyKeys(endpoint, PROJECT_ENDPOINT_KEYS)) return null;
    const endpointUrl = boundedText(endpoint.url, 2_048);
    if (!endpointUrl || !rawUrlHasNoPath(endpointUrl)) return null;
    try {
        const url = new URL(endpointUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:"
            || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
        return { url: url.origin };
    } catch (error: unknown) {
        if (error instanceof TypeError) return null;
        throw error;
    }
}

function discardedDetailFieldsAreValid(project: Record<string, unknown>): boolean {
    if (project.config !== undefined && plainRecord(project.config) === null) return false;
    if (project.anon_key !== undefined && boundedText(project.anon_key, 16_384) === null) return false;
    return project.services === undefined || Array.isArray(project.services);
}

function projectDetails(candidate: unknown, expectedRef: string): SafeProjectDetails | null {
    const project = plainRecord(candidate);
    if (!project || !hasOnlyKeys(project, PROJECT_DETAILS_KEYS)) return null;
    const summary = projectedSummary(project);
    const database = projectDatabase(project.database);
    const api = project.api === undefined ? undefined : projectEndpoint(project.api);
    const studio = project.studio === undefined ? undefined : projectEndpoint(project.studio);
    if (!summary || summary.ref !== expectedRef || !database || !discardedDetailFieldsAreValid(project)
        || project.api !== undefined && !api || project.studio !== undefined && !studio) return null;
    return {
        ...summary,
        database,
        ...(api ? { api } : {}),
        ...(studio ? { studio } : {}),
    };
}

function payloadWithinLimit(candidate: unknown): boolean {
    try {
        const serializedPayload = JSON.stringify(candidate);
        return serializedPayload !== undefined
            && new TextEncoder().encode(serializedPayload).byteLength <= PROJECT_READ_RESPONSE_MAX_BYTES;
    } catch {
        // Serialization failures make the untrusted remote payload invalid and must not reach diagnostics.
        return false;
    }
}

function safeProjectList(candidate: unknown): SafeProjectSummary[] | null {
    if (!payloadWithinLimit(candidate) || !Array.isArray(candidate) || candidate.length > MAX_PROJECTS) return null;
    const safeProjects: SafeProjectSummary[] = [];
    const ids = new Set<string>();
    const refs = new Set<string>();
    for (const projectCandidate of candidate) {
        const project = projectSummary(projectCandidate);
        if (!project || ids.has(project.id) || refs.has(project.ref)) return null;
        ids.add(project.id);
        refs.add(project.ref);
        safeProjects.push(project);
    }
    return safeProjects;
}

function validHttpStatus(status: number): boolean {
    return Number.isSafeInteger(status) && status >= 100 && status <= 599;
}

function successfulResponse(response: HttpResult<unknown>): boolean {
    return response.ok === true && validHttpStatus(response.status)
        && response.status >= 200 && response.status <= 299;
}

function failedResult(message: string): ProjectReadResult {
    return { text: `❌ ${message}`, isError: true };
}

function failedHttpResult(label: string, status: number): ProjectReadResult {
    return failedResult(validHttpStatus(status) ? `${label} request failed (${status})` : `${label} request failed`);
}

function successfulResult(payload: SafeProjectSummary[] | SafeProjectDetails): ProjectReadResult {
    return { text: JSON.stringify(payload, null, 2), isError: false };
}

export function projectListRead(response: HttpResult<unknown>): ProjectReadResult {
    if (!successfulResponse(response)) return failedHttpResult("Project list", response.status);
    const projects = safeProjectList(response.data);
    return projects ? successfulResult(projects) : failedResult("Invalid project list response");
}

export function projectGetRead(
    response: HttpResult<unknown>,
    expectedRef: string,
): ProjectReadResult {
    if (!successfulResponse(response)) return failedHttpResult("Project get", response.status);
    if (!payloadWithinLimit(response.data)) return failedResult("Invalid project response");
    const project = projectDetails(response.data, expectedRef);
    return project ? successfulResult(project) : failedResult("Invalid project response");
}
