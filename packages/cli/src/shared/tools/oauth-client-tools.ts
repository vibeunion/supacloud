import { Type } from "@sinclair/typebox";
import { projectRefPathSegment } from "../project-ref";
import { optional, stringEnum, withDescription } from "../schema";
import type { ToolSchema } from "../schema";
import type { HttpResult, HttpTransport } from "../transports/http";
import {
    releaseControlFailure,
    releaseControlMutationFailure,
    releaseControlSuccess,
    type ReleaseControlToolResponse,
} from "./release-control-response";

type ToolServer = {
    tool: (
        name: string,
        description: string,
        schema: ToolSchema,
        callback: (args: Record<string, unknown>) => Promise<ReleaseControlToolResponse>,
    ) => void;
};

type ReleaseCanaryOAuthClient = {
    client_id: string;
    client_name: "supacloud-release-canary";
    client_type: "public";
    token_endpoint_auth_method: "none";
    redirect_uris: [string];
    grant_types: ["authorization_code"];
    response_types: ["code"];
};

const RELEASE_CANARY_CLIENT_NAME = "supacloud-release-canary";
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._~-]{1,256}$/;
const MAX_CLIENT_LIST_BYTES = 256 * 1024;
const READ_TIMEOUT_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function releaseCanaryCallbackUri(value: unknown): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error("'redirect_uri' is required");
    }
    let uri: URL;
    try {
        uri = new URL(value);
    } catch {
        throw new Error("'redirect_uri' must be an absolute HTTPS or loopback HTTP URL");
    }
    const loopback = uri.hostname === "127.0.0.1" || uri.hostname === "[::1]";
    const isHttps = uri.protocol === "https:";
    const isPortBoundLoopback = uri.protocol === "http:" && loopback && Boolean(uri.port);
    if ((!isHttps && !isPortBoundLoopback) || !uri.hostname || uri.username || uri.password || uri.search || uri.hash) {
        throw new Error("'redirect_uri' must be an exact HTTPS callback or port-bound loopback HTTP callback without credentials, query, or fragment");
    }
    return uri.toString();
}

function createdClientId(value: unknown): string | null {
    if (!isRecord(value)) return null;
    try {
        return clientId(value.client_id);
    } catch {
        return null;
    }
}

function clientId(value: unknown): string {
    if (typeof value !== "string" || !CLIENT_ID_PATTERN.test(value)) {
        throw new Error("'client_id' is invalid");
    }
    return value;
}

function projectRef(value: unknown): string {
    if (typeof value !== "string" || !value.trim()) throw new Error("'ref' is required");
    return projectRefPathSegment(value.trim(), "OAuth client");
}

function oauthClientsPath(ref: string): string {
    return `/v1/projects/${encodeURIComponent(ref)}/auth/oauth-clients`;
}

function expectedClient(value: unknown, redirectUri?: string): ReleaseCanaryOAuthClient | null {
    if (!isRecord(value)
        || typeof value.client_id !== "string"
        || !CLIENT_ID_PATTERN.test(value.client_id)
        || value.client_name !== RELEASE_CANARY_CLIENT_NAME
        || value.client_type !== "public"
        || value.token_endpoint_auth_method !== "none"
        || !Array.isArray(value.redirect_uris)
        || value.redirect_uris.length !== 1
        || !Array.isArray(value.grant_types)
        || value.grant_types.length !== 1
        || value.grant_types[0] !== "authorization_code"
        || !Array.isArray(value.response_types)
        || value.response_types.length !== 1
        || value.response_types[0] !== "code") return null;
    let callback: string;
    try {
        callback = releaseCanaryCallbackUri(value.redirect_uris[0]);
    } catch {
        return null;
    }
    if (redirectUri !== undefined && callback !== redirectUri) return null;
    return {
        client_id: value.client_id,
        client_name: RELEASE_CANARY_CLIENT_NAME,
        client_type: "public",
        token_endpoint_auth_method: "none",
        redirect_uris: [callback],
        grant_types: ["authorization_code"],
        response_types: ["code"],
    };
}

function clientInventory(value: unknown): ReleaseCanaryOAuthClient[] | null {
    if (!isRecord(value) || !Array.isArray(value.clients)) return null;
    const clients = value.clients
        .filter((client) => isRecord(client) && client.client_name === RELEASE_CANARY_CLIENT_NAME)
        .map((client) => expectedClient(client));
    if (clients.some((client) => client === null)) return null;
    const inventory = clients as ReleaseCanaryOAuthClient[];
    return new Set(inventory.map((client) => client.client_id)).size === inventory.length ? inventory : null;
}

function readFailure(
    operation: string,
    response: HttpResult<unknown>,
): ReleaseControlToolResponse | null {
    if (!response.ok) {
        return releaseControlFailure(
            operation,
            response.responseReadError ? "INVALID_RESPONSE" : "HTTP_ERROR",
            response.transportError ? null : response.status,
        );
    }
    return null;
}

async function listClients(
    http: HttpTransport,
    ref: string,
): Promise<{ response: HttpResult<unknown>; clients: ReleaseCanaryOAuthClient[] | null }> {
    const response = await http.get(oauthClientsPath(ref), {
        maxJsonBytes: MAX_CLIENT_LIST_BYTES,
        responseTimeoutMs: READ_TIMEOUT_MS,
    });
    return { response, clients: response.ok && response.status === 200 ? clientInventory(response.data) : null };
}

async function getClient(
    http: HttpTransport,
    ref: string,
    id: string,
): Promise<{ response: HttpResult<unknown>; client: ReleaseCanaryOAuthClient | null }> {
    const response = await http.get(`${oauthClientsPath(ref)}/${encodeURIComponent(id)}`, {
        maxJsonBytes: MAX_CLIENT_LIST_BYTES,
        responseTimeoutMs: READ_TIMEOUT_MS,
    });
    return { response, client: response.ok && response.status === 200 ? expectedClient(response.data) : null };
}

function exactSingleClient(
    inventory: readonly ReleaseCanaryOAuthClient[],
    redirectUri: string,
): ReleaseCanaryOAuthClient | null {
    return inventory.length === 1 && inventory[0]?.redirect_uris[0] === redirectUri
        ? inventory[0]
        : null;
}

async function listReleaseCanaryClients(
    http: HttpTransport,
    ref: string,
): Promise<ReleaseControlToolResponse> {
    const read = await listClients(http, ref);
    const failure = readFailure("oauth_clients.list", read.response);
    if (failure) return failure;
    if (!read.clients) return releaseControlFailure("oauth_clients.list", "INVALID_RESPONSE", read.response.status);
    return releaseControlSuccess("oauth_clients.list", { project_ref: ref, clients: read.clients });
}

async function getReleaseCanaryClient(
    http: HttpTransport,
    ref: string,
    id: string,
): Promise<ReleaseControlToolResponse> {
    const read = await getClient(http, ref, id);
    const failure = readFailure("oauth_clients.get", read.response);
    if (failure) return failure;
    if (!read.client || read.client.client_id !== id) {
        return releaseControlFailure("oauth_clients.get", "INVALID_RESPONSE", read.response.status);
    }
    return releaseControlSuccess("oauth_clients.get", { project_ref: ref, client: read.client });
}

async function createReleaseCanaryClient(
    http: HttpTransport,
    ref: string,
    redirectUri: string,
): Promise<ReleaseControlToolResponse> {
    const before = await listClients(http, ref);
    const beforeFailure = readFailure("oauth_clients.create", before.response);
    if (beforeFailure) return beforeFailure;
    if (!before.clients) return releaseControlFailure("oauth_clients.create", "INVALID_RESPONSE", before.response.status);
    const existing = exactSingleClient(before.clients, redirectUri);
    if (existing) {
        return releaseControlSuccess("oauth_clients.create", {
            project_ref: ref,
            client: existing,
            reused: true,
        });
    }
    if (before.clients.length > 0) {
        return releaseControlFailure("oauth_clients.create", "MUTATION_NOT_SUCCEEDED", null, { project_ref: ref });
    }
    const mutation = await http.postReleaseMutation(oauthClientsPath(ref), {
        client_type: "public",
        token_endpoint_auth_method: "none",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code"],
        client_name: RELEASE_CANARY_CLIENT_NAME,
    });
    if (!mutation.ok) {
        return releaseControlMutationFailure("oauth_clients.create", mutation, { project_ref: ref });
    }
    // Only the create receipt identity is trusted before the exact post-read.
    const createdId = createdClientId(mutation.data);
    if (!createdId) return releaseControlFailure("oauth_clients.create", "OUTCOME_UNKNOWN", mutation.status, { project_ref: ref });
    const read = await getClient(http, ref, createdId);
    const readFailureResult = readFailure("oauth_clients.create", read.response);
    if (readFailureResult || !read.client || read.client.client_id !== createdId
        || read.client.redirect_uris[0] !== redirectUri) {
        return releaseControlFailure("oauth_clients.create", "OUTCOME_UNKNOWN", mutation.status, { project_ref: ref });
    }
    return releaseControlSuccess("oauth_clients.create", {
        project_ref: ref,
        client: read.client,
        reused: false,
    });
}

async function deleteReleaseCanaryClient(
    http: HttpTransport,
    ref: string,
    id: string,
    redirectUri: string,
): Promise<ReleaseControlToolResponse> {
    const before = await getClient(http, ref, id);
    const beforeFailure = readFailure("oauth_clients.delete", before.response);
    if (beforeFailure) return beforeFailure;
    if (!before.client || before.client.client_id !== id || before.client.redirect_uris[0] !== redirectUri) {
        return releaseControlFailure("oauth_clients.delete", "MUTATION_NOT_SUCCEEDED", null, { project_ref: ref });
    }
    const mutation = await http.deleteReleaseMutation(`${oauthClientsPath(ref)}/${encodeURIComponent(id)}`);
    if (!mutation.ok || ![200, 204].includes(mutation.status)) {
        return releaseControlMutationFailure("oauth_clients.delete", mutation, { project_ref: ref });
    }
    const after = await listClients(http, ref);
    const afterFailure = readFailure("oauth_clients.delete", after.response);
    if (afterFailure || !after.clients || after.clients.some((client) => client.client_id === id)) {
        return releaseControlFailure("oauth_clients.delete", "OUTCOME_UNKNOWN", mutation.status, { project_ref: ref });
    }
    return releaseControlSuccess("oauth_clients.delete", {
        project_ref: ref,
        client_id: id,
        deleted: true,
    });
}

export function registerOAuthClientTools(server: ToolServer, http: HttpTransport): void {
    server.tool(
        "oauth_clients",
        "Dedicated release-canary public OAuth client lifecycle. It only manages the exact supacloud-release-canary public authorization-code client and never returns client secrets.",
        {
            action: withDescription(stringEnum(["list", "get", "create", "delete"]), "OAuth client action"),
            ref: withDescription(Type.String(), "Central SupAuth project ref"),
            client_id: optional(Type.String(), "[get/delete] Exact release-canary public OAuth client ID"),
            redirect_uri: optional(Type.String(), "[create/delete] Exact HTTPS or port-bound RFC 8252 loopback callback"),
        },
        async ({ action, ref, client_id, redirect_uri }) => {
            const targetRef = projectRef(ref);
            if (action === "list") return listReleaseCanaryClients(http, targetRef);
            if (action === "get") return getReleaseCanaryClient(http, targetRef, clientId(client_id));
            if (action === "create") {
                return createReleaseCanaryClient(http, targetRef, releaseCanaryCallbackUri(redirect_uri));
            }
            if (action === "delete") {
                return deleteReleaseCanaryClient(
                    http,
                    targetRef,
                    clientId(client_id),
                    releaseCanaryCallbackUri(redirect_uri),
                );
            }
            throw new Error("Unknown OAuth client action");
        },
    );
}
