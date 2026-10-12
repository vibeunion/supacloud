import { afterEach, expect, test } from "bun:test";
import type { ApplicationDeployResult } from "@supacloud/delivery";
import { HttpTransport } from "../transports/http";
import { runProjectDeployment } from "./project-deployment";

const mutationId = "11234567-89ab-4def-8123-456789abcdef";
const configurationId = "21234567-89ab-4def-8123-456789abcdef";
const activationId = "31234567-89ab-4def-8123-456789abcdef";
const request = {
    ref: "demo", id: "reviews", environment_id: "test",
    mutation_id: mutationId, configuration_id: configurationId, release_id: "a".repeat(64),
    expected_plan_sha256: "b".repeat(64), approved_migration_digest: "c".repeat(64),
    web: {
        deployment_id: "web", release_id: "d".repeat(64), mutation_id: activationId,
        expected_active_release_id: "absent", expected_activation_id: "absent",
    },
};

function receipt(): ApplicationDeployResult {
    return {
        schema: "supacloud.application-deploy.v1",
        project_ref: "demo", application_id: "reviews", environment_id: "test",
        mutation_id: mutationId, release_id: request.release_id, configuration_id: configurationId,
        activation_id: activationId, expected_activation_id: null, plan_sha256: request.expected_plan_sha256,
        action: "activate", replayed: false, execution_performed: true,
        backend_receipt: {
            schema: "supacloud.application-backend-receipt.v1",
            project_ref: "demo", application_id: "reviews", environment_id: "test",
            mutation_id: mutationId, release_id: request.release_id, manifest_sha256: "e".repeat(64),
            plan_sha256: request.expected_plan_sha256, backup_id: null,
            before_ledger_digest: "f".repeat(64), after_ledger_digest: "f".repeat(64),
            applied_versions: [], schema_reloaded: false, postgrest_healthy: true,
        },
        web: { deployment_id: "web", release_id: request.web.release_id, activation_id: activationId, replayed: false },
    };
}

function state() {
    return {
        schema: "supacloud.project-deployment-status.v1", deployment_id: mutationId,
        operation: "application.release.deploy", status: "succeeded", phase: "verifying",
        project_ref: "demo", application_id: "reviews", environment_id: "test", receipt: receipt(),
    };
}

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

function transport(post: unknown, get: unknown = {}, postStatus = 200, getStatus = 200) {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const server = Bun.serve({
        port: 0,
        async fetch(input) {
            calls.push({ method: input.method, path: new URL(input.url).pathname,
                body: input.method === "POST" ? await input.json() : undefined });
            return Response.json(input.method === "POST" ? post : get, {
                status: input.method === "POST" ? postStatus : getStatus,
            });
        },
    });
    servers.push(server);
    return { calls, http: new HttpTransport({ baseUrl: server.url.origin, token: "fixture" }) };
}

test("submits one exact request, including reviewed digests, and accepts only a bound receipt", async () => {
    const fixture = transport({ ok: true, ...receipt() });
    const result = await runProjectDeployment(fixture.http, request);
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
        ok: true, deployment_id: mutationId, release_id: request.release_id,
        backend_receipt: { postgrest_healthy: true },
    });
    expect(fixture.calls).toEqual([{
        method: "POST", path: "/v1/projects/demo/environments/test/deployments",
        body: {
            deployment_id: mutationId, application_id: "reviews",
            release_id: request.release_id, configuration_id: configurationId, web: request.web,
            expected_plan_sha256: request.expected_plan_sha256,
            approved_migration_digest: request.approved_migration_digest,
        },
    }]);
});

const invalidReceipts: Array<[string, (value: ApplicationDeployResult) => unknown]> = [
    ["ok flag only", () => ({ ok: true })],
    ["project", value => ({ ...value, project_ref: "other" })],
    ["application", value => ({ ...value, application_id: "other" })],
    ["environment", value => ({ ...value, environment_id: "production" })],
    ["mutation", value => ({ ...value, mutation_id: activationId })],
    ["release", value => ({ ...value, release_id: "c".repeat(64) })],
    ["configuration", value => ({ ...value, configuration_id: activationId })],
    ["plan", value => ({ ...value, plan_sha256: "c".repeat(64) })],
    ["backend identity", value => ({ ...value, backend_receipt: { ...value.backend_receipt, project_ref: "other" } })],
    ["backend health", value => ({ ...value, backend_receipt: { ...value.backend_receipt, postgrest_healthy: false } })],
    ["migration backup", value => ({ ...value, backend_receipt: { ...value.backend_receipt, applied_versions: ["1"] } })],
    ["missing web", value => { const { web: _web, ...rest } = value; return rest; }],
    ["wrong web", value => ({ ...value, web: { ...value.web, release_id: "c".repeat(64) } })],
    ["extra secret", value => ({ ...value, secret: "private-value" })],
];
for (const [label, change] of invalidReceipts) {
    test(`does not manufacture success for ${label}`, async () => {
        const fixture = transport({ ok: true, ...change(receipt()) as Record<string, unknown> }, {}, 200, 404);
        const result = await runProjectDeployment(fixture.http, request);
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]!.text)).toMatchObject({
            ok: false, deployment_id: mutationId, error: { code: "OUTCOME_UNKNOWN" },
        });
        expect(result.content[0]!.text).not.toContain("private-value");
        expect(fixture.calls.map(call => call.method)).toEqual(["POST", "GET"]);
    });
}

test("recovers a lost response only by reading the same verified mutation without another POST", async () => {
    const fixture = transport({ error: "private-error" }, state(), 503);
    const result = await runProjectDeployment(fixture.http, request);
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
        ok: true, deployment_id: mutationId, replayed: true, execution_performed: false,
    });
    expect(fixture.calls.map(call => call.method)).toEqual(["POST", "GET"]);
    expect(fixture.calls[1]?.path).toEndWith(`/${mutationId}`);
});

for (const change of [
    { status: "running" }, { phase: "migrating" }, { environment_id: "production" },
    { deployment_id: activationId }, { operation: "functions.release.publish" },
    { receipt: { ...receipt(), release_id: "c".repeat(64) } }, { receipt: null },
]) {
    test(`rejects unverified recovered state ${JSON.stringify(change)}`, async () => {
        const fixture = transport({}, { ...state(), ...change }, 503);
        const result = await runProjectDeployment(fixture.http, request);
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]!.text).error.code).toBe("OUTCOME_UNKNOWN");
        expect(fixture.calls.map(call => call.method)).toEqual(["POST", "GET"]);
    });
}

test("unexpected successful HTTP status remains uncertain, not HTTP_ERROR or success", async () => {
    const fixture = transport({ ok: true, ...receipt() }, {}, 202, 404);
    const result = await runProjectDeployment(fixture.http, request);
    expect(JSON.parse(result.content[0]!.text).error.code).toBe("OUTCOME_UNKNOWN");
});

test("authorization rejection does not trigger status or another mutation", async () => {
    const fixture = transport({ error: "private-value" }, {}, 403);
    const result = await runProjectDeployment(fixture.http, request);
    expect(JSON.parse(result.content[0]!.text).error.code).toBe("HTTP_ERROR");
    expect(result.content[0]!.text).not.toContain("private-value");
    expect(fixture.calls).toHaveLength(1);
});

test("invalid input makes no HTTP request", async () => {
    const fixture = transport({});
    const result = await runProjectDeployment(fixture.http, { ...request, mutation_id: "bad" });
    expect(result.isError).toBe(true);
    expect(fixture.calls).toHaveLength(0);
});
