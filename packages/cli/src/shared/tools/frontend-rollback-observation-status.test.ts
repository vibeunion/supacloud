import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { FRONTEND_ARCHIVE_FORMAT, FRONTEND_ARCHIVE_RELEASE_SCHEMA } from "@supacloud/delivery/frontend-archive";
import type { HttpResult } from "../transports/http";
import { rollbackFrontendRelease, type FrontendReleaseHttp } from "./frontend-release-control";

const PROJECT = "rollback-status";
const DEPLOYMENT = "web";
const CURRENT = "a".repeat(64);
const TARGET = "b".repeat(64);
const CURRENT_ACTIVATION = "00000000-0000-4000-8000-000000000001";
const ROLLBACK = "00000000-0000-4000-8000-000000000002";
const binding = { expectedActiveReleaseId: CURRENT, expectedActivationId: CURRENT_ACTIVATION, mutationId: ROLLBACK };

function record(releaseId: string) {
    return {
        schema: FRONTEND_ARCHIVE_RELEASE_SCHEMA, project_ref: PROJECT, deployment_id: DEPLOYMENT,
        release_id: releaseId, sha256: releaseId, tree_sha256: "c".repeat(64),
        size_bytes: 256, file_count: 1, created_at: "2026-10-15T00:00:00.000Z",
        kind: "prebuilt_static", archive_format: FRONTEND_ARCHIVE_FORMAT,
    };
}

function fixture(overrides: Partial<{
    committed: boolean; artifactStatus: number; journalStatus: number; postStatus: number;
}> = {}) {
    const state = { committed: false, artifactStatus: 200, journalStatus: 200, postStatus: 200, ...overrides };
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const base = `/v1/projects/${PROJECT}/frontend/deployments/${DEPLOYMENT}`;
    const reply = <T>(status: number, data: unknown): HttpResult<T> => ({
        ok: status >= 200 && status < 300, status, data: data as T,
    });
    const http: FrontendReleaseHttp = {
        async get<T>(path: string): Promise<HttpResult<T>> {
            calls.push({ method: "GET", path });
            if (path === `${base}/active-release`) {
                const releaseId = state.committed ? TARGET : CURRENT;
                return reply<T>(200, {
                    project_ref: PROJECT, deployment_id: DEPLOYMENT,
                    active_release_id: releaseId,
                    active_activation_id: state.committed ? ROLLBACK : CURRENT_ACTIVATION,
                    releases: [record(releaseId)], next_cursor: null,
                });
            }
            if (path === `${base}/releases/${TARGET}`) {
                return reply<T>(state.artifactStatus, {
                    project_ref: PROJECT, deployment_id: DEPLOYMENT, release: record(TARGET),
                });
            }
            if (path === `/v1/projects/${PROJECT}/mutations/${ROLLBACK}`) {
                return reply<T>(state.journalStatus, {
                    project_ref: PROJECT,
                    mutation: {
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
                        completed_at: "2026-10-15T00:00:00.000Z",
                        created_at: "2026-10-15T00:00:00.000Z", updated_at: "2026-10-15T00:00:00.000Z",
                    },
                });
            }
            throw new Error(`Unexpected fixture GET: ${path}`);
        },
        async post<T>(path: string, body?: unknown): Promise<HttpResult<T>> {
            calls.push({ method: "POST", path, body });
            expect(path).toBe(`${base}/releases/${TARGET}/activate`);
            expect(body).toEqual({
                expected_active_release_id: CURRENT, expected_activation_id: CURRENT_ACTIVATION, mutation_id: ROLLBACK,
            });
            state.committed = true;
            return reply<T>(state.postStatus, {
                project_ref: PROJECT, deployment_id: DEPLOYMENT, active_release_id: TARGET,
                activation_id: ROLLBACK, release: record(TARGET),
                mutation: { mutation_id: ROLLBACK, status: "succeeded", replayed: false },
            });
        },
        async postBinary() { throw new Error("Rollback must not upload an archive"); },
    };
    return { calls, run: () => rollbackFrontendRelease(http, PROJECT, DEPLOYMENT, TARGET, binding) };
}

function assertUnknown(result: Awaited<ReturnType<typeof rollbackFrontendRelease>>) {
    expect(result.isError).toBe(true);
    const payload: unknown = JSON.parse(result.content[0]!.text);
    expect(payload).toMatchObject({
        operation: "frontend.rollback", mutation_id: ROLLBACK, target_release_id: TARGET,
        expected_active_release_id: CURRENT, expected_activation_id: CURRENT_ACTIVATION,
        error: { code: "OUTCOME_UNKNOWN" },
    });
}

describe("receipt-bound rollback requires final HTTP evidence", () => {
    for (const status of [201, 202, 206, 299]) {
        test(`target preflight HTTP ${status} cannot authorize a POST`, async () => {
            const f = fixture({ artifactStatus: status });
            const result = await f.run();
            expect(result.isError).toBe(true);
            expect(JSON.parse(result.content[0]!.text)).toMatchObject({
                mutation_id: ROLLBACK, error: { code: "INVALID_RESPONSE", http_status: status },
            });
            expect(f.calls.filter(call => call.method === "POST")).toHaveLength(0);
        });

        test(`journal HTTP ${status} cannot confirm a completed replay`, async () => {
            const f = fixture({ committed: true, journalStatus: status });
            assertUnknown(await f.run());
            expect(f.calls.filter(call => call.method === "POST")).toHaveLength(0);
        });

        test(`artifact readback HTTP ${status} cannot confirm a completed replay`, async () => {
            const f = fixture({ committed: true, artifactStatus: status });
            assertUnknown(await f.run());
            expect(f.calls.filter(call => call.method === "POST")).toHaveLength(0);
        });

        test(`mutation HTTP ${status} needs independent final evidence even with a success-shaped body`, async () => {
            const f = fixture({ postStatus: status, journalStatus: 404 });
            assertUnknown(await f.run());
            expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
            expect(f.calls.some(call => call.path.endsWith(`/mutations/${ROLLBACK}`))).toBe(true);
        });
    }

    test("HTTP 200 evidence confirms a repeated request without a POST", async () => {
        const f = fixture({ committed: true });
        const result = await f.run();
        expect(result.isError).not.toBe(true);
        expect(JSON.parse(result.content[0]!.text)).toMatchObject({ rollback: true, activation_id: ROLLBACK });
        expect(f.calls.filter(call => call.method === "POST")).toHaveLength(0);
    });

    test("independent final journal and live readback can prove an HTTP 202 mutation without a retry", async () => {
        const f = fixture({ postStatus: 202 });
        const result = await f.run();
        expect(result.isError).not.toBe(true);
        expect(JSON.parse(result.content[0]!.text)).toMatchObject({ rollback: true, activation_id: ROLLBACK });
        expect(f.calls.filter(call => call.method === "POST")).toHaveLength(1);
        expect(f.calls.some(call => call.path.endsWith(`/mutations/${ROLLBACK}`))).toBe(true);
    });
});
