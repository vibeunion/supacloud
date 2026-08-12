import { expect, test } from "bun:test";
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
    });
});
