import type { HttpResult } from "../transports/http";

export const RELEASE_CONTROL_RESPONSE_SCHEMA = "supacloud.cli.release-control.v1";

export interface ReleaseControlToolResponse {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
}

export function releaseControlSuccess(
    operation: string,
    payload: Record<string, unknown>,
): ReleaseControlToolResponse {
    return releaseControlResponse({
        ...payload,
        schema: RELEASE_CONTROL_RESPONSE_SCHEMA,
        ok: true,
        operation,
    });
}

export function releaseControlFailure(
    operation: string,
    code: "HTTP_ERROR" | "INVALID_RESPONSE" | "MUTATION_NOT_SUCCEEDED" | "OUTCOME_UNKNOWN",
    httpStatus: number | null,
    safeState: Record<string, unknown> = {},
): ReleaseControlToolResponse {
    return releaseControlErrorResponse({
        ...safeState,
        schema: RELEASE_CONTROL_RESPONSE_SCHEMA,
        ok: false,
        operation,
        error: { code, http_status: httpStatus },
    });
}

export function releaseControlMutationFailure(
    operation: string,
    response: HttpResult<unknown>,
    safeState: Record<string, unknown> = {},
): ReleaseControlToolResponse {
    const outcomeUnknown = response.transportError
        || response.responseReadError
        || response.status === 408
        || response.status >= 500;
    return outcomeUnknown
        ? releaseControlFailure(operation, "OUTCOME_UNKNOWN", response.transportError ? null : response.status, safeState)
        : releaseControlFailure(operation, "HTTP_ERROR", response.status, safeState);
}

function releaseControlResponse(
    payload: Record<string, unknown>,
): ReleaseControlToolResponse {
    return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    };
}

function releaseControlErrorResponse(
    payload: Record<string, unknown>,
): ReleaseControlToolResponse {
    return { ...releaseControlResponse(payload), isError: true };
}
