import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpTransport } from "../transports/http";
import { deployFunctionManifest } from "./project-function-release";

const RELEASE_ID = "a1111111-1111-4111-8111-111111111111";
const ALPHA_ACTIVATION = "b2222222-2222-4222-8222-222222222222";
const BETA_ACTIVATION = "c3333333-3333-4333-8333-333333333333";
const MUTATION_ID = "d4444444-4444-4444-8444-444444444444";
const RELEASED_ALPHA_ACTIVATION = "e5555555-5555-4555-8555-555555555555";
const RELEASED_BETA_ACTIVATION = "f6666666-6666-4666-8666-666666666666";
const RELEASED_LEGACY_ACTIVATION = "a7777777-7777-4777-8777-777777777777";
const ALPHA_ARTIFACT = "a".repeat(64);
const BETA_ARTIFACT = "b".repeat(64);

function temporaryManifest(): { root: string; manifest: string } {
    const root = mkdtempSync(join(tmpdir(), "supacloud-function-release-test-"));
    writeFileSync(join(root, "alpha.js"), "export default () => new Response('alpha');\n");
    writeFileSync(join(root, "beta.js"), "export default () => new Response('beta');\n");
    const manifest = join(root, "release.json");
    writeFileSync(manifest, JSON.stringify({
        functions: [
            { slug: "alpha", entrypoint: "alpha.ts", verify_jwt: false },
            { slug: "beta", entrypoint: "beta.ts", verify_jwt: true },
        ],
    }));
    return { root, manifest };
}

test("stages requested functions and publishes one complete project release", async () => {
    const { root, manifest } = temporaryManifest();
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const http = {
        get: async (path: string) => {
            requests.push({ method: "GET", path });
            if (path.endsWith("/function-releases")) {
                return {
                    ok: true, status: 200,
                    data: {
                        project_ref: "proj",
                        active_release_id: RELEASE_ID,
                        functions: [{ slug: "legacy", version: "7", activation_id: "legacy" }],
                    },
                };
            }
            const slug = path.includes("/alpha/") ? "alpha" : "beta";
            return {
                ok: true, status: 200,
                data: {
                    project_ref: "proj", slug, active_version: "absent",
                    activation_id: slug === "alpha" ? ALPHA_ACTIVATION : BETA_ACTIVATION,
                    verify_jwt: slug === "alpha" ? false : true,
                    background_routes: [],
                },
            };
        },
        postReleaseMutation: async (path: string, body: unknown) => {
            requests.push({ method: "POST", path, body });
            if (path.endsWith("/alpha/stage")) {
                return { ok: true, status: 200, data: { version: "8", artifact_sha256: ALPHA_ARTIFACT } };
            }
            if (path.endsWith("/beta/stage")) {
                return { ok: true, status: 200, data: { version: "3", artifact_sha256: BETA_ARTIFACT } };
            }
            return {
                ok: true, status: 200,
                data: {
                    project_ref: "proj", active_release_id: MUTATION_ID, generation: 4,
                    functions: [
                        { slug: "alpha", version: "8", activation_id: RELEASED_ALPHA_ACTIVATION },
                        { slug: "beta", version: "3", activation_id: RELEASED_BETA_ACTIVATION },
                        { slug: "legacy", version: "7", activation_id: RELEASED_LEGACY_ACTIVATION },
                    ],
                    mutation: { mutation_id: MUTATION_ID, status: "succeeded" },
                },
            };
        },
    } as unknown as HttpTransport;

    try {
        const response = await deployFunctionManifest(http, {
            ref: "proj",
            manifest,
            "bundles-dir": root,
            atomic: true,
            "mutation-id": MUTATION_ID,
        });
        const payload = JSON.parse(response.content[0].text);
        expect(response.isError).toBeUndefined();
        expect(payload).toMatchObject({
            ok: true,
            operation: "edge_functions.deploy_manifest",
            project_ref: "proj",
            mutation_id: MUTATION_ID,
            expected_release_id: RELEASE_ID,
            retained_functions: ["legacy"],
        });
        expect(payload.functions).toEqual([
            { slug: "alpha", version: "8", activation_id: RELEASED_ALPHA_ACTIVATION },
            { slug: "beta", version: "3", activation_id: RELEASED_BETA_ACTIVATION },
            { slug: "legacy", version: "7", activation_id: RELEASED_LEGACY_ACTIVATION },
        ]);
        const releaseCall = requests.find((request) => request.path.endsWith("/function-releases") && request.method === "POST");
        expect(releaseCall?.body).toEqual({
            mutation_id: MUTATION_ID,
            expected_release_id: RELEASE_ID,
            functions: [
                { slug: "alpha", version: "8", expected_activation_id: ALPHA_ACTIVATION },
                { slug: "beta", version: "3", expected_activation_id: BETA_ACTIVATION },
                { slug: "legacy", version: "7", expected_activation_id: "legacy" },
            ],
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("returns outcome unknown when atomic publication acknowledgement is unavailable", async () => {
    const { root, manifest } = temporaryManifest();
    const http = {
        get: async (path: string) => {
            const slug = path.includes("/beta/") ? "beta" : "alpha";
            return path.endsWith("/function-releases")
            ? {
                ok: true, status: 200,
                data: { project_ref: "proj", active_release_id: null, functions: [] },
            }
            : {
                ok: true, status: 200,
                data: {
                    project_ref: "proj", slug, active_version: "absent",
                    activation_id: "legacy", verify_jwt: slug === "alpha" ? false : true, background_routes: [],
                },
            };
        },
        postReleaseMutation: async (path: string) => path.endsWith("/stage")
            ? {
                ok: true, status: 200,
                data: {
                    version: "1",
                    artifact_sha256: path.includes("/beta/") ? BETA_ARTIFACT : ALPHA_ARTIFACT,
                },
            }
            : {
                ok: false, status: 503, transportError: true,
                data: { error: "network" },
            },
    } as unknown as HttpTransport;

    try {
        const response = await deployFunctionManifest(http, {
            ref: "proj", manifest, "bundles-dir": root, atomic: true, "mutation-id": MUTATION_ID,
        });
        const payload = JSON.parse(response.content[0].text);
        expect(response.isError).toBe(true);
        expect(payload.error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: null });
        expect(payload.mutation_id).toBe(MUTATION_ID);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("returns outcome unknown for a malformed atomic publication receipt", async () => {
    const { root, manifest } = temporaryManifest();
    const http = {
        get: async (path: string) => path.endsWith("/function-releases")
            ? {
                ok: true, status: 200,
                data: { project_ref: "proj", active_release_id: null, functions: [] },
            }
            : {
                ok: true, status: 200,
                data: {
                    project_ref: "proj", slug: path.includes("/beta/") ? "beta" : "alpha",
                    active_version: "absent", activation_id: "legacy", verify_jwt: true, background_routes: [],
                },
            },
        postReleaseMutation: async (path: string) => path.endsWith("/stage")
            ? {
                ok: true, status: 200,
                data: {
                    version: "1",
                    artifact_sha256: path.includes("/beta/") ? BETA_ARTIFACT : ALPHA_ARTIFACT,
                },
            }
            : {
                ok: true, status: 200,
                data: {
                    project_ref: "proj", active_release_id: MUTATION_ID, generation: 1,
                    functions: [{ slug: "alpha", version: "1", activation_id: "legacy" }],
                    mutation: { mutation_id: MUTATION_ID, status: "succeeded" },
                },
            },
    } as unknown as HttpTransport;

    try {
        const response = await deployFunctionManifest(http, {
            ref: "proj", manifest, "bundles-dir": root, atomic: true, "mutation-id": MUTATION_ID,
        });
        const payload = JSON.parse(response.content[0].text);
        expect(response.isError).toBe(true);
        expect(payload.error).toEqual({ code: "OUTCOME_UNKNOWN", http_status: 200 });
        expect(payload.mutation_id).toBe(MUTATION_ID);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
