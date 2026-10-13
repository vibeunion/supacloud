import { Type } from "typebox";
import { Value } from "typebox/value";
import {
    ApplicationDeployRequestSchema, ApplicationIdSchema, parseApplicationDeployResult,
} from "@supacloud/delivery";
import type { ToolResult } from "../tool-server";
import type { HttpTransport } from "../transports/http";
import { releaseControlFailure, releaseControlMutationFailure, releaseControlSuccess } from "./release-control-response";

export async function requireProjectDeploymentProtocol(
    http: Pick<HttpTransport, "get">,
    projectRef: string,
    environmentId: string,
): Promise<void> {
    const response = await http.get(
        `/v1/projects/${encodeURIComponent(projectRef)}/environments/${encodeURIComponent(environmentId)}/deployments/protocol`,
        { retry: false, totalTimeoutMs: 5_000, maxJsonBytes: 4_096 },
    );
    if (response.transportError || response.responseReadError || response.status >= 500
        || response.status === 401 || response.status === 403 || response.status === 429) {
        throw new Error(`DEPLOYMENT_PROTOCOL_UNAVAILABLE: Cannot verify the selected server (HTTP ${response.status}). Check connectivity, credentials and server health; no upload or deployment was attempted.`);
    }
    const data = response.data;
    if (response.status !== 200 || !response.ok || !data || typeof data !== "object"
        || !("protocol" in data) || data.protocol !== "supacloud.project-deployment.v1"
        || !("project_ref" in data) || data.project_ref !== projectRef
        || !("environment_id" in data) || data.environment_id !== environmentId) {
        throw new Error("DEPLOYMENT_PROTOCOL_MISMATCH: Upgrade the SupaCloud server and CLI together (`npm install -g @supacloud/cli@latest`), then retry `supacloud deploy`. No upload or deployment was attempted; legacy endpoints will not be used.");
    }
}

const operation = "applications.project_deploy";
const scopeSchema = Type.Object({
    project_ref: Type.String({ pattern: "^[a-z0-9-]{1,20}$" }),
    application_id: ApplicationIdSchema,
    environment_id: ApplicationIdSchema,
});
const statusSchema = Type.Object({
    schema: Type.Literal("supacloud.project-deployment-status.v1"),
    deployment_id: ApplicationDeployRequestSchema.properties.mutation_id,
    status: Type.Union([
        Type.Literal("pending"), Type.Literal("running"), Type.Literal("succeeded"),
        Type.Literal("failed_retryable"), Type.Literal("failed_terminal"), Type.Literal("outcome_unknown"),
    ]),
    phase: Type.Union([
        Type.Literal("queued"), Type.Literal("prepared"), Type.Literal("migrating"),
        Type.Literal("activating"), Type.Literal("binding-web"), Type.Literal("verifying"),
    ]),
    operation: Type.Literal("application.release.deploy"),
    ...scopeSchema.properties,
    receipt: Type.Optional(Type.Unknown()),
    failure_code: Type.Optional(Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,63}$" })),
}, { additionalProperties: false });

function responseReceipt(data: unknown, expected: Parameters<typeof parseApplicationDeployResult>[1]) {
    if (!data || typeof data !== "object" || Array.isArray(data) || !("ok" in data) || data.ok !== true) {
        throw new Error("Invalid project deployment response");
    }
    const { ok: _ok, ...receipt } = data;
    return parseApplicationDeployResult(receipt, expected);
}

export async function runProjectDeployment(
    http: Pick<HttpTransport, "post" | "get">,
    args: Record<string, unknown>,
): Promise<ToolResult> {
    const scope = { project_ref: args.ref, application_id: args.id, environment_id: args.environment_id };
    const request = {
        mutation_id: args.mutation_id,
        release_id: args.release_id,
        ...(args.configuration_id === undefined ? {} : { configuration_id: args.configuration_id }),
        ...(args.configuration_write === undefined ? {} : { configuration_write: args.configuration_write }),
        ...(args.expected_plan_sha256 === undefined ? {} : { expected_plan_sha256: args.expected_plan_sha256 }),
        ...(args.approved_migration_digest === undefined ? {} : { approved_migration_digest: args.approved_migration_digest }),
        ...(args.web_release === undefined ? {} : { web_release: args.web_release }),
    };
    if (!Value.Check(scopeSchema, scope) || !Value.Check(ApplicationDeployRequestSchema, request)
        || (request.configuration_id !== undefined && request.configuration_write !== undefined
            && request.configuration_id !== request.configuration_write.configuration_id)) {
        return releaseControlFailure(operation, "INVALID_RESPONSE", null);
    }
    const expected = { ...scope, request };
    const identity = { ...scope, deployment_id: request.mutation_id, mutation_id: request.mutation_id,
        release_id: request.release_id };
    const endpoint = `/v1/projects/${encodeURIComponent(scope.project_ref)}/environments/${encodeURIComponent(scope.environment_id)}/deployments`;
    const { mutation_id, ...candidate } = request;
    const result = await http.post(endpoint, {
        ...candidate, deployment_id: mutation_id, application_id: scope.application_id,
    }, { timeoutMs: 120_000, maxJsonBytes: 131_072, responseTimeoutMs: 30_000 });
    if (result.ok && result.status === 200) {
        try {
            return releaseControlSuccess(operation, {
                ...responseReceipt(result.data, expected), deployment_id: mutation_id,
            });
        } catch {
            // A malformed success can still follow a committed write. Only read its durable state.
        }
    } else if (!result.ok && !result.transportError && !result.responseReadError
        && result.status < 500 && result.status !== 408) {
        return releaseControlMutationFailure(operation, result, identity);
    }

    const observed = await http.get(`${endpoint}/${encodeURIComponent(mutation_id)}`, {
        retry: false, totalTimeoutMs: 30_000, maxJsonBytes: 131_072,
    });
    try {
        if (!observed.ok || observed.status !== 200 || !Value.Check(statusSchema, observed.data)) throw new Error();
        const state = observed.data;
        if (state.deployment_id !== mutation_id || state.project_ref !== scope.project_ref
            || state.application_id !== scope.application_id || state.environment_id !== scope.environment_id
            || state.status !== "succeeded" || state.phase !== "verifying") throw new Error();
        const receipt = parseApplicationDeployResult(state.receipt, expected);
        return releaseControlSuccess(operation, {
            ...receipt, deployment_id: mutation_id, replayed: true, execution_performed: false,
        });
    } catch {
        return releaseControlFailure(operation, "OUTCOME_UNKNOWN",
            result.transportError ? null : result.status, identity);
    }
}
