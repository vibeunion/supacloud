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
    code: "HTTP_ERROR" | "INVALID_RESPONSE" | "MUTATION_NOT_SUCCEEDED" | "OUTCOME_UNKNOWN" | "PARTIAL_SUCCESS",
    httpStatus: number | null,
    safeState: Record<string, unknown> = {},
): ReleaseControlToolResponse {
    const outcomeUnknown = code === "OUTCOME_UNKNOWN";
    return releaseControlErrorResponse({
        ...safeState,
        schema: RELEASE_CONTROL_RESPONSE_SCHEMA,
        ok: false,
        operation,
        error: { code, http_status: httpStatus },
        ...(outcomeUnknown
            ? {
                message: "部署结果无法确认：服务端可能已经完成操作，但客户端未收到可验证的最终结果。",
                next_action: "请先查询当前部署状态或发布回执，再决定是否重试；不要直接重复提交。",
            }
            : {}),
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
