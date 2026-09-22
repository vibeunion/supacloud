import { expect, test } from "bun:test";
import { outcomeUnknownGuidance } from "../outcome-guidance";
import {
    RELEASE_CONTROL_RESPONSE_SCHEMA,
    releaseControlFailure,
    releaseControlSuccess,
} from "./release-control-response";

function responsePayload(response: { content: Array<{ text: string }> }): Record<string, unknown> {
    return JSON.parse(response.content[0].text) as Record<string, unknown>;
}

test("release-control extensions cannot override success envelope invariants", () => {
    const response = releaseControlSuccess("expected.operation", {
        schema: "attacker-schema",
        ok: false,
        operation: "attacker.operation",
    });

    expect(responsePayload(response)).toMatchObject({
        schema: RELEASE_CONTROL_RESPONSE_SCHEMA,
        ok: true,
        operation: "expected.operation",
    });
});

test("release-control safe state cannot override failure envelope invariants", () => {
    const response = releaseControlFailure("expected.operation", "OUTCOME_UNKNOWN", 503, {
        schema: "attacker-schema",
        ok: true,
        operation: "attacker.operation",
        error: { code: "attacker-code", http_status: 200 },
    });

    expect(response.isError).toBe(true);
    expect(responsePayload(response)).toMatchObject({
        schema: RELEASE_CONTROL_RESPONSE_SCHEMA,
        ok: false,
        operation: "expected.operation",
        error: { code: "OUTCOME_UNKNOWN", http_status: 503 },
        message: "部署结果无法确认：服务端可能已经完成操作，但客户端未收到可验证的最终结果。",
        next_action: "请先查询当前部署状态或发布回执，再决定是否重试；不要直接重复提交。",
    });
});

test("release-control ordinary failures do not add outcome guidance", () => {
    const response = releaseControlFailure("expected.operation", "HTTP_ERROR", 400);

    expect(responsePayload(response)).toEqual({
        schema: RELEASE_CONTROL_RESPONSE_SCHEMA,
        ok: false,
        operation: "expected.operation",
        error: { code: "HTTP_ERROR", http_status: 400 },
    });
});

test("unknown outcome keeps the receipt unchanged and provides safe terminal guidance", () => {
    const response = releaseControlFailure("edge_functions.deploy", "OUTCOME_UNKNOWN", 503);
    expect(responsePayload(response)).toEqual({
        schema: RELEASE_CONTROL_RESPONSE_SCHEMA,
        ok: false,
        operation: "edge_functions.deploy",
        error: { code: "OUTCOME_UNKNOWN", http_status: 503 },
    });
    const guidance = outcomeUnknownGuidance(response.content[0].text);
    expect(guidance).toContain("操作结果无法确认");
    expect(guidance).toContain("不要直接重复提交");
    expect(outcomeUnknownGuidance(response.content[0].text)).toBe(guidance);
});

test("terminal guidance never reflects upstream details", () => {
    const guidance = outcomeUnknownGuidance(JSON.stringify({
        ok: false,
        error: { code: "OUTCOME_UNKNOWN", message: "private-server-secret" },
    }));
    expect(guidance).not.toBeNull();
    expect(guidance).not.toContain("private-server-secret");
});

test.each([
    "OUTCOME_UNKNOWN",
    "invalid JSON",
    "null",
    '{"ok":true,"error":{"code":"OUTCOME_UNKNOWN"}}',
    '{"ok":false,"error":{"code":"HTTP_ERROR"}}',
    '{"ok":false,"error":null}',
])("does not misclassify other output: %s", (text) => {
    expect(outcomeUnknownGuidance(text)).toBeNull();
});

test("release-control ordinary failures do not add outcome guidance", () => {
    const response = releaseControlFailure("expected.operation", "HTTP_ERROR", 400);

    expect(responsePayload(response)).toEqual({
        schema: RELEASE_CONTROL_RESPONSE_SCHEMA,
        ok: false,
        operation: "expected.operation",
        error: { code: "HTTP_ERROR", http_status: 400 },
    });
});
