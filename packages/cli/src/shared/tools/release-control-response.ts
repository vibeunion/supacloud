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
        schema: RELEASE_CONTROL_RESPONSE_SCHEMA,
        ok: true,
        operation,
        ...payload,
    });
}

export function releaseControlFailure(
    operation: string,
    code: "HTTP_ERROR" | "INVALID_RESPONSE" | "OUTCOME_UNKNOWN",
    httpStatus: number | null,
): ReleaseControlToolResponse {
    return releaseControlErrorResponse({
        schema: RELEASE_CONTROL_RESPONSE_SCHEMA,
        ok: false,
        operation,
        error: { code, http_status: httpStatus },
    });
}

export function releaseControlMutationFailure(
    operation: string,
    response: HttpResult<unknown>,
): ReleaseControlToolResponse {
    const outcomeUnknown = response.transportError || response.status === 408 || response.status >= 500;
    return outcomeUnknown
        ? releaseControlFailure(operation, "OUTCOME_UNKNOWN", response.transportError ? null : response.status)
        : releaseControlFailure(operation, "HTTP_ERROR", response.status);
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
