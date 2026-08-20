import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    activateFrontendRelease,
    getFrontendRelease,
    listFrontendReleases,
    uploadFrontendRelease,
} from "./frontend-release-control";

const PROJECT_REF = "abcdefghijklmnopqrst";
const DEPLOYMENT_ID = "fa-web";
const RELEASE_ID = "a".repeat(64);
const TREE_SHA = "b".repeat(64);
const MUTATION_ID = "00000000-0000-4000-8000-000000000001";
const roots = new Set<string>();

function release(releaseId = RELEASE_ID, treeSha = TREE_SHA) {
    return {
        schema: "supacloud.frontend-release.v1",
        project_ref: PROJECT_REF,
        deployment_id: DEPLOYMENT_ID,
        release_id: releaseId,
        sha256: releaseId,
        tree_sha256: treeSha,
        size_bytes: 3,
        file_count: 1,
        created_at: "2026-08-12T00:00:00.000Z",
        kind: "prebuilt_static",
    };
}

function parsed(response: { content: Array<{ text: string }> }): Record<string, unknown> {
    return JSON.parse(response.content[0].text) as Record<string, unknown>;
}

afterEach(async () => {
    await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
    roots.clear();
});

describe("immutable frontend release control", () => {
    test("lists and gets only strict secret-free release projections", async () => {
        const inventory = {
            project_ref: PROJECT_REF,
            deployment_id: DEPLOYMENT_ID,
            active_release_id: null,
            active_activation_id: null,
            releases: [{ ...release(), token: "must-not-escape" }],
            next_cursor: null,
        };
        const http = {
            get: async (path: string) => path.includes(`/${RELEASE_ID}`)
                ? {
                    ok: true, status: 200,
                    data: {
                        project_ref: PROJECT_REF,
                        deployment_id: DEPLOYMENT_ID,
                        release: release(),
                    },
                }
                : { ok: true, status: 200, data: inventory },
        };
        const malformedList = await listFrontendReleases(http as never, PROJECT_REF, DEPLOYMENT_ID);
        expect(malformedList.isError).toBe(true);
        expect(malformedList.content[0].text).not.toContain("must-not-escape");

        inventory.releases = [release() as never];
        const listed = await listFrontendReleases(http as never, PROJECT_REF, DEPLOYMENT_ID, undefined, 25);
        const read = await getFrontendRelease(http as never, PROJECT_REF, DEPLOYMENT_ID, RELEASE_ID);
        expect(parsed(listed).releases).toEqual([expect.objectContaining({ release_id: RELEASE_ID })]);
        expect((parsed(read).release as Record<string, unknown>).tree_sha256).toBe(TREE_SHA);
    });

    test("uploads raw verified bytes and requires exact immutable readback", async () => {
        const root = await mkdtemp(join(tmpdir(), "supacloud-cli-frontend-release-"));
        roots.add(root);
        const path = join(root, "site.zip");
        await writeFile(path, "zip");
        const calls: Array<{ method: string; path: string; options?: Record<string, unknown> }> = [];
        const http = {
            postBinary: async (endpoint: string, body: {
                stream: ReadableStream<Uint8Array>;
            }, options: Record<string, unknown>) => {
                calls.push({ method: "POST", path: endpoint, options });
                const bytes = new Uint8Array(await new Response(body.stream).arrayBuffer());
                expect(new TextDecoder().decode(bytes)).toBe("zip");
                const digest = String(options.contentSha256);
                return {
                    ok: true,
                    status: 201,
                    data: {
                        project_ref: PROJECT_REF,
                        deployment_id: DEPLOYMENT_ID,
                        release: { ...release(), release_id: digest, sha256: digest },
                    },
                };
            },
            get: async (endpoint: string) => {
                calls.push({ method: "GET", path: endpoint });
                const digest = endpoint.split("/").at(-1)!;
                return {
                    ok: true,
                    status: 200,
                    data: {
                        project_ref: PROJECT_REF,
                        deployment_id: DEPLOYMENT_ID,
                        release: { ...release(), release_id: digest, sha256: digest },
                    },
                };
            },
        };

        const response = await uploadFrontendRelease(http as never, PROJECT_REF, DEPLOYMENT_ID, path);
        expect(response.isError).not.toBe(true);
        expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
        expect(calls[0].options).toMatchObject({ contentType: "application/zip", contentLength: 3 });
    });

    test("streams archive bytes in bounded chunks without buffering the file", async () => {
        const root = await mkdtemp(join(tmpdir(), "supacloud-cli-frontend-release-stream-"));
        roots.add(root);
        const path = join(root, "site.zip");
        const archiveBytes = new Uint8Array(64 * 1024 * 2 + 17).fill(0x61);
        await writeFile(path, archiveBytes);
        const chunkLengths: number[] = [];
        const response = await uploadFrontendRelease({
            postBinary: async (_endpoint: string, body: {
                stream: ReadableStream<Uint8Array>;
                byteLength: number;
            }, options: Record<string, unknown>) => {
                const reader = body.stream.getReader();
                let streamedBytes = 0;
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunkLengths.push(value.byteLength);
                    streamedBytes += value.byteLength;
                }
                expect(streamedBytes).toBe(body.byteLength);
                const digest = String(options.contentSha256);
                return {
                    ok: true,
                    status: 201,
                    data: {
                        project_ref: PROJECT_REF,
                        deployment_id: DEPLOYMENT_ID,
                        release: release(digest),
                    },
                };
            },
            get: async (endpoint: string) => {
                const digest = endpoint.split("/").at(-1)!;
                return {
                    ok: true,
                    status: 200,
                    data: {
                        project_ref: PROJECT_REF,
                        deployment_id: DEPLOYMENT_ID,
                        release: release(digest),
                    },
                };
            },
        } as never, PROJECT_REF, DEPLOYMENT_ID, path);

        expect(response.isError).not.toBe(true);
        expect(chunkLengths).toEqual([64 * 1024, 64 * 1024, 17]);
    });

    test("rejects upload readback envelopes and records for another deployment", async () => {
        const root = await mkdtemp(join(tmpdir(), "supacloud-cli-frontend-release-identity-"));
        roots.add(root);
        const path = join(root, "site.zip");
        await writeFile(path, "zip");
        const response = await uploadFrontendRelease({
            postBinary: async (_endpoint: string, _body: unknown, options: Record<string, unknown>) => {
                const digest = String(options.contentSha256);
                return {
                    ok: true,
                    status: 201,
                    data: {
                        project_ref: PROJECT_REF,
                        deployment_id: DEPLOYMENT_ID,
                        release: { ...release(), release_id: digest, sha256: digest },
                    },
                };
            },
            get: async (endpoint: string) => {
                const digest = endpoint.split("/").at(-1)!;
                return {
                    ok: true,
                    status: 200,
                    data: {
                        project_ref: PROJECT_REF,
                        deployment_id: "other-web",
                        release: {
                            ...release(),
                            deployment_id: "other-web",
                            release_id: digest,
                            sha256: digest,
                        },
                    },
                };
            },
        } as never, PROJECT_REF, DEPLOYMENT_ID, path);

        expect(parsed(response).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 200 });
    });

    test("converges on the content-addressed release after the upload response body times out", async () => {
        const root = await mkdtemp(join(tmpdir(), "supacloud-cli-frontend-release-readback-"));
        roots.add(root);
        const path = join(root, "site.zip");
        await writeFile(path, "zip");
        let digest = "";
        const response = await uploadFrontendRelease({
            postBinary: async (_endpoint: string, _body: unknown, options: Record<string, unknown>) => {
                digest = String(options.contentSha256);
                return {
                    ok: false,
                    status: 201,
                    data: { token: "must-not-escape" },
                    responseReadError: true,
                };
            },
            get: async () => ({
                ok: true,
                status: 200,
                data: {
                    project_ref: PROJECT_REF,
                    deployment_id: DEPLOYMENT_ID,
                    release: { ...release(), release_id: digest, sha256: digest },
                },
            }),
        } as never, PROJECT_REF, DEPLOYMENT_ID, path);

        expect(response.isError).not.toBe(true);
        expect((parsed(response).release as Record<string, unknown>).release_id).toBe(digest);
        expect(response.content[0].text).not.toContain("must-not-escape");
    });

    test.each([400, 401, 403, 409, 429])(
        "preserves deterministic HTTP %s upload failures without readback",
        async (status) => {
            const root = await mkdtemp(join(tmpdir(), "supacloud-cli-frontend-release-4xx-"));
            roots.add(root);
            const path = join(root, "site.zip");
            await writeFile(path, "zip");
            let reads = 0;
            const response = await uploadFrontendRelease({
                postBinary: async () => ({
                    ok: false,
                    status,
                    data: { token: "must-not-escape" },
                    responseError: true,
                }),
                get: async () => {
                    reads += 1;
                    return { ok: true, status: 200, data: {} };
                },
            } as never, PROJECT_REF, DEPLOYMENT_ID, path);

            expect(parsed(response).error).toEqual({ code: "HTTP_ERROR", http_status: status });
            expect(reads).toBe(0);
            expect(response.content[0].text).not.toContain("must-not-escape");
        },
    );

    test("reads back an HTTP 408 upload outcome", async () => {
        const root = await mkdtemp(join(tmpdir(), "supacloud-cli-frontend-release-408-"));
        roots.add(root);
        const path = join(root, "site.zip");
        await writeFile(path, "zip");
        let digest = "";
        let reads = 0;
        const response = await uploadFrontendRelease({
            postBinary: async (_endpoint: string, _body: unknown, options: Record<string, unknown>) => {
                digest = String(options.contentSha256);
                return { ok: false, status: 408, data: null };
            },
            get: async () => {
                reads += 1;
                return {
                    ok: true,
                    status: 200,
                    data: {
                        project_ref: PROJECT_REF,
                        deployment_id: DEPLOYMENT_ID,
                        release: release(digest),
                    },
                };
            },
        } as never, PROJECT_REF, DEPLOYMENT_ID, path);

        expect(response.isError).not.toBe(true);
        expect(reads).toBe(1);
    });

    test("rejects a symlink archive before any HTTP request", async () => {
        const root = await mkdtemp(join(tmpdir(), "supacloud-cli-frontend-release-link-"));
        roots.add(root);
        await writeFile(join(root, "site.zip"), "zip");
        await symlink(join(root, "site.zip"), join(root, "link.zip"));
        let requests = 0;
        await expect(uploadFrontendRelease({
            postBinary: async () => {
                requests += 1;
                return { ok: true, status: 201, data: {} };
            },
        } as never, PROJECT_REF, DEPLOYMENT_ID, join(root, "link.zip"))).rejects.toThrow();
        expect(requests).toBe(0);
    });

    test("activates with exact CAS and proves the activation generation by inventory", async () => {
        const calls: Array<{ method: string; body?: unknown }> = [];
        const http = {
            post: async (_path: string, body: unknown, options: Record<string, unknown>) => {
                calls.push({ method: "POST", body });
                expect(options).toEqual({
                    maxJsonBytes: 1024 * 1024,
                    responseTimeoutMs: 5_000,
                });
                return {
                    ok: true,
                    status: 200,
                    data: {
                        project_ref: PROJECT_REF,
                        deployment_id: DEPLOYMENT_ID,
                        active_release_id: RELEASE_ID,
                        activation_id: MUTATION_ID,
                        release: release(),
                        mutation: { mutation_id: MUTATION_ID, status: "succeeded", replayed: false },
                    },
                };
            },
            get: async (path: string) => {
                calls.push({ method: "GET" });
                if (path.endsWith(`/${RELEASE_ID}`)) {
                    return {
                        ok: true,
                        status: 200,
                        data: {
                            project_ref: PROJECT_REF,
                            deployment_id: DEPLOYMENT_ID,
                            release: release(),
                        },
                    };
                }
                return {
                    ok: true,
                    status: 200,
                    data: {
                        project_ref: PROJECT_REF,
                        deployment_id: DEPLOYMENT_ID,
                        active_release_id: RELEASE_ID,
                        active_activation_id: MUTATION_ID,
                        releases: [release()],
                        next_cursor: null,
                    },
                };
            },
        };
        const response = await activateFrontendRelease(http as never, {
            projectRef: PROJECT_REF,
            deploymentId: DEPLOYMENT_ID,
            releaseId: RELEASE_ID,
            expectedActiveReleaseId: "absent",
            expectedActivationId: "absent",
            mutationId: MUTATION_ID,
        });
        expect(response.isError).not.toBe(true);
        expect(calls).toEqual([
            {
                method: "POST",
                body: {
                    expected_active_release_id: "absent",
                    expected_activation_id: "absent",
                    mutation_id: MUTATION_ID,
                },
            },
            { method: "GET" },
            { method: "GET" },
        ]);
    });

    test("rejects activation inventories that exceed the requested page limit", async () => {
        let reads = 0;
        const response = await activateFrontendRelease({
            post: async () => ({
                ok: true,
                status: 200,
                data: {
                    project_ref: PROJECT_REF,
                    deployment_id: DEPLOYMENT_ID,
                    active_release_id: RELEASE_ID,
                    activation_id: MUTATION_ID,
                    release: release(),
                    mutation: { mutation_id: MUTATION_ID, status: "succeeded", replayed: false },
                },
            }),
            get: async () => {
                reads += 1;
                return {
                    ok: true,
                    status: 200,
                    data: {
                        project_ref: PROJECT_REF,
                        deployment_id: DEPLOYMENT_ID,
                        active_release_id: RELEASE_ID,
                        active_activation_id: MUTATION_ID,
                        releases: Array.from({ length: 101 }, (_, index) => release(
                            index.toString(16).padStart(64, "0"),
                            (index + 101).toString(16).padStart(64, "0"),
                        )),
                        next_cursor: RELEASE_ID,
                    },
                };
            },
        } as never, {
            projectRef: PROJECT_REF,
            deploymentId: DEPLOYMENT_ID,
            releaseId: RELEASE_ID,
            expectedActiveReleaseId: "absent",
            expectedActivationId: "absent",
            mutationId: MUTATION_ID,
        });

        expect(parsed(response).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 200 });
        expect(reads).toBe(1);
    });

    test("rejects activation inventory records for another project", async () => {
        const response = await activateFrontendRelease({
            post: async () => ({
                ok: true,
                status: 200,
                data: {
                    project_ref: PROJECT_REF,
                    deployment_id: DEPLOYMENT_ID,
                    active_release_id: RELEASE_ID,
                    activation_id: MUTATION_ID,
                    release: release(),
                    mutation: { mutation_id: MUTATION_ID, status: "succeeded", replayed: false },
                },
            }),
            get: async () => ({
                ok: true,
                status: 200,
                data: {
                    project_ref: PROJECT_REF,
                    deployment_id: DEPLOYMENT_ID,
                    active_release_id: RELEASE_ID,
                    active_activation_id: MUTATION_ID,
                    releases: [{ ...release(), project_ref: "other-project" }],
                    next_cursor: null,
                },
            }),
        } as never, {
            projectRef: PROJECT_REF,
            deploymentId: DEPLOYMENT_ID,
            releaseId: RELEASE_ID,
            expectedActiveReleaseId: "absent",
            expectedActivationId: "absent",
            mutationId: MUTATION_ID,
        });

        expect(parsed(response).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 200 });
    });

    test("rejects an exact activation readback for another release", async () => {
        const response = await activateFrontendRelease({
            post: async () => ({
                ok: true,
                status: 200,
                data: {
                    project_ref: PROJECT_REF,
                    deployment_id: DEPLOYMENT_ID,
                    active_release_id: RELEASE_ID,
                    activation_id: MUTATION_ID,
                    release: release(),
                    mutation: { mutation_id: MUTATION_ID, status: "succeeded", replayed: false },
                },
            }),
            get: async (path: string) => path.endsWith(`/${RELEASE_ID}`)
                ? {
                    ok: true,
                    status: 200,
                    data: {
                        project_ref: PROJECT_REF,
                        deployment_id: DEPLOYMENT_ID,
                        release: release("c".repeat(64)),
                    },
                }
                : {
                    ok: true,
                    status: 200,
                    data: {
                        project_ref: PROJECT_REF,
                        deployment_id: DEPLOYMENT_ID,
                        active_release_id: RELEASE_ID,
                        active_activation_id: MUTATION_ID,
                        releases: [],
                        next_cursor: RELEASE_ID,
                    },
                },
        } as never, {
            projectRef: PROJECT_REF,
            deploymentId: DEPLOYMENT_ID,
            releaseId: RELEASE_ID,
            expectedActiveReleaseId: "absent",
            expectedActivationId: "absent",
            mutationId: MUTATION_ID,
        });

        expect(parsed(response).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 200 });
    });

    test("does not reflect malformed or failed remote activation bodies", async () => {
        let readbacks = 0;
        const response = await activateFrontendRelease({
            post: async () => ({
                ok: false,
                status: 503,
                data: { token: "remote-secret", detail: "private detail" },
            }),
            get: async () => {
                readbacks += 1;
                return { ok: false, status: 404, data: { detail: "private readback" } };
            },
        } as never, {
            projectRef: PROJECT_REF,
            deploymentId: DEPLOYMENT_ID,
            releaseId: RELEASE_ID,
            expectedActiveReleaseId: "absent",
            expectedActivationId: "absent",
            mutationId: MUTATION_ID,
        });
        expect(parsed(response).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 503 });
        expect(readbacks).toBe(1);
        expect(response.content[0].text).not.toContain("remote-secret");
        expect(response.content[0].text).not.toContain("private detail");
    });

    test("proves a lost activation response with durable mutation and inventory readback", async () => {
        let reads = 0;
        const olderReleases = Array.from({ length: 100 }, (_, index) => {
            const releaseId = (index + 1).toString(16).padStart(64, "0");
            return release(releaseId, (index + 101).toString(16).padStart(64, "0"));
        });
        const response = await activateFrontendRelease({
            post: async () => ({ ok: false, status: 500, data: null, transportError: true }),
            get: async (path: string) => {
                reads += 1;
                if (reads === 1) {
                    return {
                        ok: true,
                        status: 200,
                        data: {
                            project_ref: PROJECT_REF,
                            mutation: {
                                project_ref: PROJECT_REF,
                                mutation_id: MUTATION_ID,
                                operation: "frontend.release.activate",
                                resource_key: "v1/frontend_release/ZmEtd2Vi",
                                request_fingerprint: "bca02488f799ea07a4aebfb2d73f8a00d058d3f96763d9653a36b88d3e7c8939",
                                principal: { type: "project", id: `project:${PROJECT_REF}` },
                                status: "succeeded",
                                checkpoint: {},
                                receipt: {},
                                response_status: 200,
                                failure_code: null,
                                lease: { owner: null, expires_at: null, fencing_epoch: 1 },
                                completed_at: "2026-08-12T00:00:00.000Z",
                                created_at: "2026-08-12T00:00:00.000Z",
                                updated_at: "2026-08-12T00:00:00.000Z",
                            },
                        },
                    };
                }
                if (path.endsWith(`/${RELEASE_ID}`)) {
                    return {
                        ok: true,
                        status: 200,
                        data: {
                            project_ref: PROJECT_REF,
                            deployment_id: DEPLOYMENT_ID,
                            release: release(),
                        },
                    };
                }
                return {
                    ok: true,
                    status: 200,
                    data: {
                        project_ref: PROJECT_REF,
                        deployment_id: DEPLOYMENT_ID,
                        active_release_id: RELEASE_ID,
                        active_activation_id: MUTATION_ID,
                        releases: olderReleases,
                        next_cursor: olderReleases.at(-1)!.release_id,
                    },
                };
            },
        } as never, {
            projectRef: PROJECT_REF,
            deploymentId: DEPLOYMENT_ID,
            releaseId: RELEASE_ID,
            expectedActiveReleaseId: "absent",
            expectedActivationId: "absent",
            mutationId: MUTATION_ID,
        });

        expect(response.isError).not.toBe(true);
        expect(parsed(response).activation_id).toBe(MUTATION_ID);
        expect(reads).toBe(3);
    });

    test("proves activation after the mutation response body times out", async () => {
        let reads = 0;
        const response = await activateFrontendRelease({
            post: async () => ({
                ok: false,
                status: 200,
                data: { error: "Response body unavailable" },
                responseReadError: true,
            }),
            get: async (path: string) => {
                reads += 1;
                if (reads === 1) {
                    return {
                        ok: true,
                        status: 200,
                        data: {
                            project_ref: PROJECT_REF,
                            mutation: {
                                project_ref: PROJECT_REF,
                                mutation_id: MUTATION_ID,
                                operation: "frontend.release.activate",
                                resource_key: "v1/frontend_release/ZmEtd2Vi",
                                request_fingerprint: "bca02488f799ea07a4aebfb2d73f8a00d058d3f96763d9653a36b88d3e7c8939",
                                principal: { type: "project", id: `project:${PROJECT_REF}` },
                                status: "succeeded",
                                checkpoint: {},
                                receipt: {},
                                response_status: 200,
                                failure_code: null,
                                lease: { owner: null, expires_at: null, fencing_epoch: 1 },
                                completed_at: "2026-08-12T00:00:00.000Z",
                                created_at: "2026-08-12T00:00:00.000Z",
                                updated_at: "2026-08-12T00:00:00.000Z",
                            },
                        },
                    };
                }
                if (path.endsWith(`/${RELEASE_ID}`)) {
                    return {
                        ok: true,
                        status: 200,
                        data: {
                            project_ref: PROJECT_REF,
                            deployment_id: DEPLOYMENT_ID,
                            release: release(),
                        },
                    };
                }
                return {
                    ok: true,
                    status: 200,
                    data: {
                        project_ref: PROJECT_REF,
                        deployment_id: DEPLOYMENT_ID,
                        active_release_id: RELEASE_ID,
                        active_activation_id: MUTATION_ID,
                        releases: [release()],
                        next_cursor: null,
                    },
                };
            },
        } as never, {
            projectRef: PROJECT_REF,
            deploymentId: DEPLOYMENT_ID,
            releaseId: RELEASE_ID,
            expectedActiveReleaseId: "absent",
            expectedActivationId: "absent",
            mutationId: MUTATION_ID,
        });

        expect(response.isError).not.toBe(true);
        expect(parsed(response).activation_id).toBe(MUTATION_ID);
        expect(reads).toBe(3);
    });

    test("rejects a lost-response mutation for a different CAS request", async () => {
        let reads = 0;
        const response = await activateFrontendRelease({
            post: async () => ({ ok: false, status: 500, data: null, transportError: true }),
            get: async () => {
                reads += 1;
                return {
                    ok: true,
                    status: 200,
                    data: {
                        project_ref: PROJECT_REF,
                        mutation: {
                            project_ref: PROJECT_REF,
                            mutation_id: MUTATION_ID,
                            operation: "frontend.release.activate",
                            resource_key: "v1/frontend_release/ZmEtd2Vi",
                            request_fingerprint: "c".repeat(64),
                            principal: { type: "project", id: `project:${PROJECT_REF}` },
                            status: "succeeded",
                            checkpoint: {},
                            receipt: {},
                            response_status: 200,
                            failure_code: null,
                            lease: { owner: null, expires_at: null, fencing_epoch: 1 },
                            completed_at: "2026-08-12T00:00:00.000Z",
                            created_at: "2026-08-12T00:00:00.000Z",
                            updated_at: "2026-08-12T00:00:00.000Z",
                        },
                    },
                };
            },
        } as never, {
            projectRef: PROJECT_REF,
            deploymentId: DEPLOYMENT_ID,
            releaseId: RELEASE_ID,
            expectedActiveReleaseId: "absent",
            expectedActivationId: "absent",
            mutationId: MUTATION_ID,
        });

        expect(parsed(response).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 500 });
        expect(reads).toBe(1);
    });

    test("reads back an HTTP 408 activation outcome", async () => {
        let reads = 0;
        const response = await activateFrontendRelease({
            post: async () => ({ ok: false, status: 408, data: null }),
            get: async () => {
                reads += 1;
                return { ok: false, status: 404, data: null };
            },
        } as never, {
            projectRef: PROJECT_REF,
            deploymentId: DEPLOYMENT_ID,
            releaseId: RELEASE_ID,
            expectedActiveReleaseId: "absent",
            expectedActivationId: "absent",
            mutationId: MUTATION_ID,
        });

        expect(parsed(response).error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 408 });
        expect(reads).toBe(1);
    });

    test.each([400, 401, 403, 409, 429])(
        "preserves deterministic HTTP %s activation failures with malformed bodies",
        async (status) => {
            let reads = 0;
            const response = await activateFrontendRelease({
                post: async () => ({
                    ok: false,
                    status,
                    data: { token: "must-not-escape" },
                    responseError: true,
                }),
                get: async () => {
                    reads += 1;
                    return { ok: true, status: 200, data: {} };
                },
            } as never, {
                projectRef: PROJECT_REF,
                deploymentId: DEPLOYMENT_ID,
                releaseId: RELEASE_ID,
                expectedActiveReleaseId: "absent",
                expectedActivationId: "absent",
                mutationId: MUTATION_ID,
            });

            expect(parsed(response).error).toEqual({ code: "HTTP_ERROR", http_status: status });
            expect(reads).toBe(0);
            expect(response.content[0].text).not.toContain("must-not-escape");
        },
    );

    test("rejects a non-canonical timestamp and missing activation mutation id", async () => {
        const malformed = release();
        malformed.created_at = "2026-02-30T00:00:00.000Z";
        const read = await getFrontendRelease({
            get: async () => ({
                ok: true,
                status: 200,
                data: { project_ref: PROJECT_REF, deployment_id: DEPLOYMENT_ID, release: malformed },
            }),
        } as never, PROJECT_REF, DEPLOYMENT_ID, RELEASE_ID);
        expect(read.isError).toBe(true);
        await expect(activateFrontendRelease({} as never, {
            projectRef: PROJECT_REF,
            deploymentId: DEPLOYMENT_ID,
            releaseId: RELEASE_ID,
            expectedActiveReleaseId: "absent",
            expectedActivationId: "absent",
            mutationId: "",
        })).rejects.toThrow("'mutation_id' must be a UUIDv4");
    });
});
