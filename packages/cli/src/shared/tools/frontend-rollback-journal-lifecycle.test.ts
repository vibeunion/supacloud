import { describe, test } from "bun:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { FRONTEND_ARCHIVE_FORMAT, FRONTEND_ARCHIVE_RELEASE_SCHEMA } from "@supacloud/delivery/frontend-archive";
import type { HttpResult } from "../transports/http";
import { rollbackFrontendRelease, type FrontendReleaseHttp } from "./frontend-release-control";

const PROJECT = "rollback-journal";
const DEPLOYMENT = "web";
const CURRENT = "a".repeat(64);
const TARGET = "b".repeat(64);
const CURRENT_ACTIVATION = "00000000-0000-4000-8000-000000000001";
const ROLLBACK = "00000000-0000-4000-8000-000000000002";
const TIMESTAMP = "2026-10-15T00:00:00.000Z";
const PRIVATE_VALUE = "journal-private-value-must-not-escape";
const binding = { expectedActiveReleaseId: CURRENT, expectedActivationId: CURRENT_ACTIVATION, mutationId: ROLLBACK };

function record(releaseId: string) {
    return {
        schema: FRONTEND_ARCHIVE_RELEASE_SCHEMA, project_ref: PROJECT, deployment_id: DEPLOYMENT,
        release_id: releaseId, sha256: releaseId, tree_sha256: "c".repeat(64),
        size_bytes: 256, file_count: 1, created_at: TIMESTAMP,
        kind: "prebuilt_static", archive_format: FRONTEND_ARCHIVE_FORMAT,
    };
}

function fixture(replay: boolean, change: Record<string, unknown>) {
    let committed = replay;
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const base = `/v1/projects/${PROJECT}/frontend/deployments/${DEPLOYMENT}`;
    const mutation = {
        project_ref: PROJECT, mutation_id: ROLLBACK, operation: "frontend.release.activate",
        resource_key: `v1/frontend_release/${Buffer.from(DEPLOYMENT).toString("base64url")}`,
        request_fingerprint: createHash("sha256").update(JSON.stringify({
            activation_id: ROLLBACK, deployment_id: DEPLOYMENT,
            expected_activation_id: CURRENT_ACTIVATION, expected_active_release_id: CURRENT,
            project_ref: PROJECT, release_id: TARGET,
        })).digest("hex"),
        principal: { type: "project", id: `project:${PROJECT}` },
        status: "succeeded", checkpoint: {}, receipt: {}, response_status: 200, failure_code: null,
        lease: { owner: null, expires_at: null, fencing_epoch: 1 },
        completed_at: TIMESTAMP, created_at: TIMESTAMP, updated_at: TIMESTAMP,
        ...change,
    };
    const reply = <T>(status: number, data: unknown): HttpResult<T> => ({
        ok: status >= 200 && status < 300, status, data: data as T,
    });
    const http: FrontendReleaseHttp = {
        async get<T>(path: string): Promise<HttpResult<T>> {
            calls.push({ method: "GET", path });
            if (path === `${base}/active-release`) {
                const releaseId = committed ? TARGET : CURRENT;
                return reply<T>(200, {
                    project_ref: PROJECT, deployment_id: DEPLOYMENT,
                    active_release_id: releaseId,
                    active_activation_id: committed ? ROLLBACK : CURRENT_ACTIVATION,
                    releases: [record(releaseId)], next_cursor: null,
                });
            }
            if (path === `${base}/releases/${TARGET}`) {
                return reply<T>(200, { project_ref: PROJECT, deployment_id: DEPLOYMENT, release: record(TARGET) });
            }
            if (path === `/v1/projects/${PROJECT}/mutations/${ROLLBACK}`) {
                return reply<T>(200, { project_ref: PROJECT, mutation });
            }
            throw new Error(`Unexpected fixture GET: ${path}`);
        },
        async post<T>(path: string, body?: unknown): Promise<HttpResult<T>> {
            calls.push({ method: "POST", path, body });
            assert.equal(path, `${base}/releases/${TARGET}/activate`);
            assert.deepEqual(body, {
                expected_active_release_id: CURRENT, expected_activation_id: CURRENT_ACTIVATION, mutation_id: ROLLBACK,
            });
            committed = true;
            return reply<T>(503, { private: PRIVATE_VALUE });
        },
        async postBinary() { throw new Error("Rollback must not upload an archive"); },
    };
    return { calls, run: () => rollbackFrontendRelease(http, PROJECT, DEPLOYMENT, TARGET, binding) };
}

const faults: ReadonlyArray<{ name: string; change: Record<string, unknown> }> = [
    { name: "missing completion", change: { completed_at: null } },
    { name: "invalid completion", change: { completed_at: PRIVATE_VALUE } },
    { name: "held terminal lease", change: { lease: { owner: "worker-1", expires_at: TIMESTAMP, fencing_epoch: 1 } } },
    { name: "invalid fencing epoch", change: { lease: { owner: null, expires_at: null, fencing_epoch: -1 } } },
    { name: "missing principal", change: { principal: null } },
    { name: "malformed principal", change: { principal: { type: "project", id: " padded " } } },
    { name: "missing checkpoint", change: { checkpoint: null } },
    { name: "private checkpoint", change: { checkpoint: { secret: PRIVATE_VALUE } } },
    { name: "missing receipt", change: { receipt: null } },
    { name: "private receipt", change: { receipt: { secret: PRIVATE_VALUE } } },
    { name: "noncanonical creation", change: { created_at: "2026-10-15T00:00:00Z" } },
    { name: "invalid update date", change: { updated_at: "2026-02-30T00:00:00.000Z" } },
];

for (const replay of [false, true]) {
    describe(replay ? "completed rollback replay" : "rollback response-loss reconciliation", () => {
        for (const { name, change } of faults) {
            test(`rejects a success-shaped journal with ${name}`, async () => {
                const f = fixture(replay, change);
                for (let attempt = 0; attempt < 2; attempt++) {
                    const result = await f.run();
                    assert.equal(result.isError, true);
                    const payload = JSON.parse(result.content[0]!.text);
                    assert.equal(payload.error.code, "OUTCOME_UNKNOWN");
                    assert.equal(payload.operation, "frontend.rollback");
                    assert.equal(payload.mutation_id, ROLLBACK);
                    assert.equal(payload.target_release_id, TARGET);
                    assert.equal(payload.expected_active_release_id, CURRENT);
                    assert.equal(payload.expected_activation_id, CURRENT_ACTIVATION);
                    assert.equal(result.content[0]!.text.includes(PRIVATE_VALUE), false);
                    assert.equal(f.calls.filter(call => call.method === "POST").length, replay ? 0 : 1);
                }
            });
        }

        // Structural validation must not silently narrow the existing principal policy.
        for (const type of ["project", "admin", "master"] as const) {
            test(`accepts a valid ${type} journal without repeating the write`, async () => {
                const principal = { type, id: type === "project" ? `project:${PROJECT}` : `${type}:operator` };
                const f = fixture(replay, { principal });
                const result = await f.run();
                assert.notEqual(result.isError, true);
                const payload = JSON.parse(result.content[0]!.text);
                assert.equal(payload.rollback, true);
                assert.equal(payload.activation_id, ROLLBACK);
                assert.equal(payload.active_release_id, TARGET);
                const repeated = await f.run();
                assert.notEqual(repeated.isError, true);
                assert.deepEqual(JSON.parse(repeated.content[0]!.text), payload);
                assert.equal(f.calls.filter(call => call.method === "POST").length, replay ? 0 : 1);
            });
        }
    });
}
