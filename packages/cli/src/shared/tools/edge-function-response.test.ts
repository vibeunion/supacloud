import { describe, expect, test } from "bun:test";

import {
    confirmedFunctionConfigMutation,
    confirmedFunctionDeletion,
    projectedFunctionIdentity,
    projectedFunctionList,
} from "./edge-function-response";

const EXPECTED_ACTIVATION_ID = "a1111111-1111-4111-8111-111111111111";
const COMMITTED_ACTIVATION_ID = "b2222222-2222-4222-8222-222222222222";
const OTHER_ACTIVATION_ID = "c3333333-3333-4333-8333-333333333333";

function configReceipt(overrides: Record<string, unknown> = {}) {
    return {
        success: true,
        project_ref: "proj",
        slug: "hook",
        expected_activation_id: EXPECTED_ACTIVATION_ID,
        activation_id: COMMITTED_ACTIVATION_ID,
        verify_jwt: false,
        background_routes: ["/queue/*"],
        ...overrides,
    };
}

function deletionReceipt(overrides: Record<string, unknown> = {}) {
    return {
        success: true,
        project_ref: "proj",
        slug: "hook",
        expected_activation_id: EXPECTED_ACTIVATION_ID,
        activation_id: COMMITTED_ACTIVATION_ID,
        previous_active_version: "4",
        active_version: "absent",
        config: {
            verify_jwt: true,
            activation_id: COMMITTED_ACTIVATION_ID,
        },
        ...overrides,
    };
}

describe("Edge Function response projection", () => {
    test("projects list and config responses without unknown fields", () => {
        const projectedList = projectedFunctionList([{
            slug: "hook",
            version: 4,
            activation_id: EXPECTED_ACTIVATION_ID,
            verify_jwt: true,
            private: "list-private-sentinel",
        }]);
        const projectedIdentity = projectedFunctionIdentity({
            project_ref: "proj",
            slug: "hook",
            active_version: "4",
            version: "4",
            activation_id: EXPECTED_ACTIVATION_ID,
            verify_jwt: true,
            background_routes: [],
            private: "config-private-sentinel",
        }, "proj", "hook");

        expect(projectedList).toEqual([{
            slug: "hook",
            version: 4,
            activation_id: EXPECTED_ACTIVATION_ID,
            verify_jwt: true,
        }]);
        expect(projectedIdentity).toEqual({
            project_ref: "proj",
            slug: "hook",
            active_version: "4",
            activation_id: EXPECTED_ACTIVATION_ID,
            verify_jwt: true,
            background_routes: [],
            version: "4",
        });
        expect(JSON.stringify({ projectedList, projectedIdentity })).not.toContain("sentinel");
    });

    test("projects a confirmed config mutation without unknown fields", () => {
        const confirmed = confirmedFunctionConfigMutation(
            configReceipt({ private: "config-mutation-private-sentinel" }),
            {
                projectRef: "proj",
                slug: "hook",
                expectedActivationId: EXPECTED_ACTIVATION_ID,
                config: { verify_jwt: false, background_routes: ["/queue/*"] },
            },
        );

        expect(confirmed).toEqual({
            project_ref: "proj",
            slug: "hook",
            expected_activation_id: EXPECTED_ACTIVATION_ID,
            activation_id: COMMITTED_ACTIVATION_ID,
            verify_jwt: false,
            background_routes: ["/queue/*"],
        });
        expect(JSON.stringify(confirmed)).not.toContain("sentinel");
    });

    test.each([
        ["wrong project", { project_ref: "other" }],
        ["wrong slug", { slug: "other" }],
        ["wrong expected activation", { expected_activation_id: OTHER_ACTIVATION_ID }],
        ["unchanged activation", { activation_id: EXPECTED_ACTIVATION_ID }],
        ["legacy committed activation", { activation_id: "legacy" }],
        ["wrong confirmed policy", { verify_jwt: true }],
    ])("rejects a config mutation with %s", (_label, override) => {
        const confirmed = confirmedFunctionConfigMutation(configReceipt(override), {
            projectRef: "proj",
            slug: "hook",
            expectedActivationId: EXPECTED_ACTIVATION_ID,
            config: { verify_jwt: false, background_routes: ["/queue/*"] },
        });

        expect(confirmed).toBeNull();
    });

    test("projects a confirmed deletion without unknown fields", () => {
        const confirmed = confirmedFunctionDeletion(
            deletionReceipt({ private: "delete-private-sentinel" }),
            {
                projectRef: "proj",
                slug: "hook",
                expectedActivationId: EXPECTED_ACTIVATION_ID,
            },
        );

        expect(confirmed).toEqual({
            project_ref: "proj",
            slug: "hook",
            expected_activation_id: EXPECTED_ACTIVATION_ID,
            activation_id: COMMITTED_ACTIVATION_ID,
            previous_active_version: "4",
            active_version: "absent",
        });
        expect(JSON.stringify(confirmed)).not.toContain("sentinel");
    });

    test.each([
        ["wrong project", { project_ref: "other" }],
        ["wrong slug", { slug: "other" }],
        ["wrong expected activation", { expected_activation_id: OTHER_ACTIVATION_ID }],
        ["unchanged activation", { activation_id: EXPECTED_ACTIVATION_ID }],
        ["active target", { active_version: "5" }],
        ["versioned tombstone config", {
            config: {
                version: "5",
                verify_jwt: true,
                activation_id: COMMITTED_ACTIVATION_ID,
            },
        }],
        ["mismatched config activation", {
            config: {
                verify_jwt: true,
                activation_id: OTHER_ACTIVATION_ID,
            },
        }],
    ])("rejects a deletion receipt with %s", (_label, override) => {
        const confirmed = confirmedFunctionDeletion(deletionReceipt(override), {
            projectRef: "proj",
            slug: "hook",
            expectedActivationId: EXPECTED_ACTIVATION_ID,
        });

        expect(confirmed).toBeNull();
    });
});
