import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFrontendArchive } from "./deploy-tools";

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../index.ts", import.meta.url));
const temporaryDirectories: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

afterEach(async () => {
    for (const server of servers.splice(0)) server.stop(true);
    await Promise.all(temporaryDirectories.splice(0).map((directory) => (
        rm(directory, { recursive: true, force: true })
    )));
});

function release(projectRef: string, deploymentId: string, releaseId: string) {
    return {
        schema: "supacloud.frontend-release.v2",
        project_ref: projectRef,
        deployment_id: deploymentId,
        release_id: releaseId,
        sha256: releaseId,
        tree_sha256: "dc8451fa5e9f82057e51c9cbf6848589753ece913961c1d8c57d5945c1376d47",
        size_bytes: 128,
        file_count: 2,
        created_at: "2026-09-02T08:00:00.000Z",
        kind: "prebuilt_static",
        archive_format: "tar.zst",
    };
}

function deployment(id = "web") {
    return {
        id,
        name: id,
        framework: "static",
        build_command: "",
        output_dir: "dist",
        deployment_url: "https://web.example.com",
    };
}

async function workspace(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "supacloud-deploy-test-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "dist", "assets"), { recursive: true });
    await writeFile(join(directory, "dist", "index.html"), "<h1>hello</h1>\n");
    await writeFile(join(directory, "dist", "assets", "app.js"), "console.log('hello');\n");
    return directory;
}

async function runCli(
    directory: string,
    apiUrl: string,
    args: string[],
    options: { injectContext?: boolean; env?: Record<string, string> } = {},
) {
    const environment: Record<string, string | undefined> = { ...process.env };
    if (options.injectContext === false) {
        for (const key of ["SUPACLOUD_API_URL", "SUPACLOUD_API_TOKEN", "SUPACLOUD_PROJECT_REF", "SUPACLOUD_ENV"]) {
            delete environment[key];
        }
    } else {
        Object.assign(environment, {
            SUPACLOUD_API_URL: apiUrl,
            SUPACLOUD_API_TOKEN: "test-token",
            SUPACLOUD_PROJECT_REF: "abc123",
            SUPACLOUD_ENV: "test",
        });
    }
    Object.assign(environment, options.env);
    const child = Bun.spawn([process.execPath, CLI_ENTRYPOINT, ...args], {
        cwd: directory,
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
}

describe("one-command deploy", () => {
    test.each(["plan", "diff"])("%s compares a built release without writes in read-only production", async (flag) => {
        const directory = await workspace();
        const archive = await createFrontendArchive(join(directory, "dist"));
        const { sha256, treeSha256 } = archive;
        await archive.cleanup();
        const requests: string[] = [];
        const server = Bun.serve({
            hostname: "127.0.0.1", port: 0,
            fetch(request) {
                const path = new URL(request.url).pathname;
                requests.push(`${request.method} ${path}`);
                if (path.endsWith("/deployments")) return Response.json([deployment()]);
                if (path.endsWith("/active-release")) return Response.json({
                    project_ref: "abc123", deployment_id: "web",
                    active_release_id: null, active_activation_id: null, releases: [], next_cursor: null,
                });
                return new Response("not found", { status: 404 });
            },
        });
        servers.push(server);
        const response = await runCli(directory, `http://127.0.0.1:${server.port}`, [
            "deploy", `--${flag}`, "--skip_build", "--json",
        ], { env: { SUPACLOUD_ENV: "production", SUPACLOUD_READ_ONLY: "true" } });
        expect(response.exitCode).toBe(0);
        expect(JSON.parse(response.stdout)).toMatchObject({
            schema: "supacloud.frontend-deploy-plan.v1",
            planned: true, published: false, unchanged: false, environment: "production",
            comparison: "immutable_release", release_id: sha256, tree_sha256: treeSha256,
            expected_active_release_id: "absent", expected_activation_id: "absent",
            actions: ["upload_release", "activate_release"],
        });
        expect(requests).toEqual([
            "GET /v1/projects/abc123/frontend/deployments",
            "GET /v1/projects/abc123/frontend/deployments/web/active-release",
        ]);
    });

    test.each([true, false])("content-equivalent trees skip writes despite different archive identities (plan: %s)", async (plan) => {
        const directory = await workspace();
        const archive = await createFrontendArchive(join(directory, "dist"));
        const treeSha256 = archive.treeSha256;
        await archive.cleanup();
        const activeId = "a".repeat(64);
        const requests: string[] = [];
        const server = Bun.serve({
            hostname: "127.0.0.1", port: 0,
            fetch(request) {
                const path = new URL(request.url).pathname;
                requests.push(`${request.method} ${path}`);
                if (path.endsWith("/deployments")) return Response.json([deployment()]);
                if (path.endsWith("/active-release")) return Response.json({
                    project_ref: "abc123", deployment_id: "web",
                    active_release_id: activeId, active_activation_id: "00000000-0000-4000-8000-000000000001",
                    releases: [{ ...release("abc123", "web", activeId), tree_sha256: treeSha256 }], next_cursor: null,
                });
                return new Response("not found", { status: 404 });
            },
        });
        servers.push(server);
        const response = await runCli(directory, `http://127.0.0.1:${server.port}`, [
            "deploy", "--skip_build", "--json", ...(plan ? ["--plan"] : []),
        ]);
        expect(response.exitCode).toBe(0);
        expect(JSON.parse(response.stdout)).toMatchObject({
            unchanged: true, tree_sha256: treeSha256,
            ...(plan ? { actions: [], published: false } : { release_id: activeId }),
        });
        expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
        expect(requests).toHaveLength(2);
    });

    test("plan runs a local build but conflicting dry_run stops before HTTP", async () => {
        const directory = await workspace();
        await writeFile(join(directory, "supacloud.json"), JSON.stringify({
            frontend: { id: "web", buildCommand: "bun -e \"require('fs').writeFileSync('built.txt','built')\"" },
        }));
        const requests: string[] = [];
        const server = Bun.serve({
            hostname: "127.0.0.1", port: 0,
            fetch(request) {
                const path = new URL(request.url).pathname;
                requests.push(`${request.method} ${path}`);
                if (path.endsWith("/deployments")) return Response.json([deployment()]);
                return Response.json({
                    project_ref: "abc123", deployment_id: "web",
                    active_release_id: null, active_activation_id: null, releases: [], next_cursor: null,
                });
            },
        });
        servers.push(server);
        const conflict = await runCli(directory, `http://127.0.0.1:${server.port}`, ["deploy", "--dry_run", "--plan", "--json"]);
        expect(conflict.exitCode).toBe(1);
        expect(requests).toEqual([]);
        const response = await runCli(directory, `http://127.0.0.1:${server.port}`, ["deploy", "--plan", "--json"]);
        expect(response.exitCode).toBe(0);
        expect(await readFile(join(directory, "built.txt"), "utf8")).toBe("built");
        expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
    });

    test("keeps build logs on stderr and only the final JSON on stdout", async () => {
        const directory = await workspace();
        await Bun.write(join(directory, "build.ts"), [
            'console.log("build output");',
            'console.error("build warning");',
            'await Bun.write("built.txt", "built");',
        ].join("\n"));
        await Bun.write(join(directory, "supacloud.json"), JSON.stringify({
            frontend: { id: "web", buildCommand: "bun build.ts" },
        }));
        const server = Bun.serve({
            hostname: "127.0.0.1", port: 0,
            fetch(request) {
                if (new URL(request.url).pathname.endsWith("/deployments")) return Response.json([deployment()]);
                return Response.json({
                    project_ref: "abc123", deployment_id: "web",
                    active_release_id: null, active_activation_id: null, releases: [], next_cursor: null,
                });
            },
        });
        servers.push(server);
        const response = await runCli(directory, `http://127.0.0.1:${server.port}`, ["deploy", "--plan", "--json"]);
        expect(response.exitCode).toBe(0);
        expect(JSON.parse(response.stdout)).toMatchObject({ planned: true, published: false });
        expect(response.stderr).toContain("build output");
        expect(response.stderr).toContain("build warning");
        expect(await Bun.file(join(directory, "built.txt")).text()).toBe("built");
    });

    test.each(["deploy", "plan", "diff"])("rejects contradictory archive/tree identity before %s", async (mode) => {
        const directory = await workspace();
        const archive = await createFrontendArchive(join(directory, "dist"));
        const releaseId = archive.sha256;
        await archive.cleanup();
        const requests: string[] = [];
        const server = Bun.serve({
            hostname: "127.0.0.1", port: 0,
            fetch(request) {
                const path = new URL(request.url).pathname;
                requests.push(`${request.method} ${path}`);
                if (path.endsWith("/deployments")) return Response.json([deployment()]);
                return Response.json({
                    project_ref: "abc123", deployment_id: "web",
                    active_release_id: releaseId,
                    active_activation_id: "00000000-0000-4000-8000-000000000001",
                    releases: [{ ...release("abc123", "web", releaseId), tree_sha256: "0".repeat(64) }],
                    next_cursor: null,
                });
            },
        });
        servers.push(server);
        const response = await runCli(directory, `http://127.0.0.1:${server.port}`, [
            "deploy", "--skip_build", "--json", ...(mode === "deploy" ? [] : [`--${mode}`]),
        ]);
        expect(response.exitCode).toBe(1);
        expect(response.stderr).toContain("Active release tree does not match the local archive");
        expect(requests).toEqual([
            "GET /v1/projects/abc123/frontend/deployments",
            "GET /v1/projects/abc123/frontend/deployments/web/active-release",
        ]);
    });

    test("unknown activation preserves its mutation identity without replay", async () => {
        const directory = await workspace();
        let writes = 0;
        let releaseId = "";
        let mutationId = "";
        const server = Bun.serve({
            hostname: "127.0.0.1", port: 0,
            async fetch(request) {
                const path = new URL(request.url).pathname;
                if (request.method === "GET" && path.endsWith("/deployments")) return Response.json([deployment()]);
                if (request.method === "GET" && path.endsWith("/active-release")) return Response.json({
                    project_ref: "abc123", deployment_id: "web", active_release_id: null,
                    active_activation_id: null, releases: [], next_cursor: null,
                });
                if (request.method === "POST" && path.endsWith("/releases")) {
                    writes++;
                    releaseId = createHash("sha256").update(new Uint8Array(await request.arrayBuffer())).digest("hex");
                    return Response.json({ project_ref: "abc123", deployment_id: "web", release: release("abc123", "web", releaseId) }, { status: 201 });
                }
                if (request.method === "GET" && path.endsWith(`/releases/${releaseId}`)) {
                    return Response.json({ project_ref: "abc123", deployment_id: "web", release: release("abc123", "web", releaseId) });
                }
                if (request.method === "POST" && path.endsWith("/activate")) {
                    writes++;
                    mutationId = (await request.json() as Record<string, string>).mutation_id!;
                    return Response.json({ token: "must-not-escape" }, { status: 503 });
                }
                return new Response("not found", { status: 404 });
            },
        });
        servers.push(server);
        const response = await runCli(directory, `http://127.0.0.1:${server.port}`, ["deploy", "--skip_build", "--json"]);
        expect(response.exitCode).toBe(1);
        expect(JSON.parse(response.stdout)).toMatchObject({
            operation: "deploy", error: { code: "OUTCOME_UNKNOWN" },
            mutation_id: mutationId, target_release_id: releaseId,
            expected_active_release_id: "absent", expected_activation_id: "absent",
        });
        expect(writes).toBe(2);
        expect(response.stdout + response.stderr).not.toContain("must-not-escape");
    });
    test("loads repository-root context when invoked from a nested frontend workspace", async () => {
        const directory = await mkdtemp(join(tmpdir(), "supacloud-monorepo-env-test-"));
        temporaryDirectories.push(directory);
        const webRoot = join(directory, "apps", "web");
        await mkdir(join(webRoot, "dist"), { recursive: true });
        await writeFile(join(webRoot, "dist", "index.html"), "web\n");
        await writeFile(join(directory, "supacloud.json"), JSON.stringify({
            targets: {
                web: {
                    type: "frontend",
                    root: "apps/web",
                    id: "web",
                    outputDirectory: "dist",
                },
            },
        }));

        const requests: string[] = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                const url = new URL(request.url);
                requests.push(`${request.method} ${url.pathname}`);
                if (url.pathname === "/v1/projects/abc123/frontend/deployments") return Response.json([deployment()]);
                return new Response("not found", { status: 404 });
            },
        });
        servers.push(server);
        await writeFile(join(directory, ".env"), [
            `SUPACLOUD_API_URL=http://127.0.0.1:${server.port}`,
            "SUPACLOUD_API_TOKEN=test-token",
            "SUPACLOUD_PROJECT_REF=abc123",
            "SUPACLOUD_ENV=test",
            "",
        ].join("\n"));

        const response = await runCli(webRoot, "", ["deploy", "--skip_build", "--dry_run", "--json"], {
            injectContext: false,
        });

        expect(response.exitCode).toBe(0);
        expect(JSON.parse(response.stdout)).toMatchObject({
            ok: true,
            dry_run: true,
            project_ref: "abc123",
            deployment_id: "web",
            output_directory: join(await realpath(directory), "apps", "web", "dist"),
        });
        expect(requests).toEqual(["GET /v1/projects/abc123/frontend/deployments"]);
    });

    test("selects a frontend target from a monorepo subdirectory and keeps output rooted there", async () => {
        const directory = await mkdtemp(join(tmpdir(), "supacloud-monorepo-test-"));
        temporaryDirectories.push(directory);
        await mkdir(join(directory, "apps", "web", "dist"), { recursive: true });
        await mkdir(join(directory, "apps", "api", "dist"), { recursive: true });
        await writeFile(join(directory, "package.json"), JSON.stringify({
            private: true,
            workspaces: ["apps/*"],
        }));
        await writeFile(join(directory, "bun.lock"), "lockfile\n");
        await writeFile(join(directory, "supacloud.json"), JSON.stringify({
            defaultTarget: "web",
            targets: {
                web: {
                    type: "frontend",
                    root: "apps/web",
                    id: "web",
                    buildCommand: "bun run build:web",
                    outputDirectory: "dist",
                },
                api: {
                    type: "edge_function",
                    root: "apps/api",
                    slug: "api",
                    bundleDirectory: "dist",
                },
            },
        }));
        await writeFile(join(directory, "apps", "web", "dist", "index.html"), "web\n");

        const requests: string[] = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                const url = new URL(request.url);
                requests.push(`${request.method} ${url.pathname}`);
                if (url.pathname === "/v1/projects/abc123/frontend/deployments") return Response.json([deployment()]);
                if (url.pathname === "/v1/projects/abc123/frontend/deployments/web/releases") {
                    return Response.json({
                        project_ref: "abc123",
                        deployment_id: "web",
                        active_release_id: null,
                        active_activation_id: null,
                        releases: [],
                        next_cursor: null,
                    });
                }
                return new Response("not found", { status: 404 });
            },
        });
        servers.push(server);

        const response = await runCli(join(directory, "apps", "web"), `http://127.0.0.1:${server.port}`, [
            "deploy", "--skip_build", "--dry_run", "--json",
        ]);

        expect(response.exitCode).toBe(0);
        expect(JSON.parse(response.stdout)).toMatchObject({
            ok: true,
            dry_run: true,
            deployment_id: "web",
            output_directory: join(await realpath(directory), "apps", "web", "dist"),
        });
        expect(requests).toEqual(["GET /v1/projects/abc123/frontend/deployments"]);
    });

    test("requires an explicit target at the monorepo root", async () => {
        const directory = await mkdtemp(join(tmpdir(), "supacloud-monorepo-root-test-"));
        temporaryDirectories.push(directory);
        await mkdir(join(directory, "apps", "web"), { recursive: true });
        await mkdir(join(directory, "apps", "api"), { recursive: true });
        await writeFile(join(directory, "supacloud.json"), JSON.stringify({
            targets: {
                web: { type: "frontend", root: "apps/web", id: "web" },
                api: { type: "edge_function", root: "apps/api", slug: "api" },
            },
        }));
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => Response.json([]),
        });
        servers.push(server);

        const response = await runCli(directory, `http://127.0.0.1:${server.port}`, ["deploy", "--dry_run"]);

        expect(response.exitCode).toBe(1);
        expect(response.stderr).toContain("Multiple deploy targets found");
    });

    test("deploys an edge-function backend from its own monorepo workspace", async () => {
        const directory = await mkdtemp(join(tmpdir(), "supacloud-monorepo-api-test-"));
        temporaryDirectories.push(directory);
        const apiRoot = join(directory, "apps", "api");
        await mkdir(join(apiRoot, "dist"), { recursive: true });
        await writeFile(join(apiRoot, "dist", "index.ts"), "export default { fetch: () => new Response('ok') };\n");
        await writeFile(join(directory, "supacloud.json"), JSON.stringify({
            targets: {
                web: { type: "frontend", root: "apps/web", id: "web" },
                api: {
                    type: "edge_function",
                    root: "apps/api",
                    slug: "api",
                    bundleDirectory: "dist",
                    entrypoint: "index.ts",
                },
            },
        }));
        const previousActivationId = "a1111111-1111-4111-8111-111111111111";
        const committedActivationId = "b2222222-2222-4222-8222-222222222222";
        let requestBody: Record<string, unknown> | null = null;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                const url = new URL(request.url);
                if (request.method === "GET" && url.pathname === "/v1/projects/abc123/functions") {
                    return Response.json([{
                        slug: "api",
                        version: 4,
                        activation_id: previousActivationId,
                        verify_jwt: true,
                    }]);
                }
                if (request.method === "POST" && url.pathname === "/v1/projects/abc123/functions/api/bundle") {
                    requestBody = await request.json() as Record<string, unknown>;
                    return Response.json({
                        success: true,
                        project_ref: "abc123",
                        slug: "api",
                        previous_active_version: "4",
                        expected_activation_id: previousActivationId,
                        activation_id: committedActivationId,
                        active_version: "5",
                        version: "5",
                        config: {
                            version: "5",
                            verify_jwt: true,
                            activation_id: committedActivationId,
                        },
                    });
                }
                return new Response("not found", { status: 404 });
            },
        });
        servers.push(server);

        const response = await runCli(apiRoot, `http://127.0.0.1:${server.port}`, [
            "deploy", "--skip_build", "--json",
        ]);

        expect(response.exitCode).toBe(0);
        expect(JSON.parse(response.stdout)).toMatchObject({
            ok: true,
            type: "edge_function",
            target: "api",
            slug: "api",
            active_version: "5",
            activation_id: committedActivationId,
        });
        expect(requestBody).toMatchObject({
            files: { "index.ts": "export default { fetch: () => new Response('ok') };\n" },
            entrypoint: "index.ts",
            expected_active_version: "4",
            expected_activation_id: previousActivationId,
        });
    });

    test("fails closed before backend deployment when the active function identity is invalid", async () => {
        const directory = await mkdtemp(join(tmpdir(), "supacloud-monorepo-api-identity-test-"));
        temporaryDirectories.push(directory);
        const apiRoot = join(directory, "apps", "api");
        await mkdir(join(apiRoot, "dist"), { recursive: true });
        await writeFile(join(apiRoot, "dist", "index.ts"), "export default { fetch: () => new Response('ok') };\n");
        await writeFile(join(directory, "supacloud.json"), JSON.stringify({
            targets: {
                api: {
                    type: "edge_function",
                    root: "apps/api",
                    slug: "api",
                    bundleDirectory: "dist",
                },
            },
        }));
        let writes = 0;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                if (request.method !== "GET") writes++;
                return Response.json({ unexpected: true });
            },
        });
        servers.push(server);

        const response = await runCli(apiRoot, `http://127.0.0.1:${server.port}`, [
            "deploy", "--skip_build", "--json",
        ]);

        expect(response.exitCode).toBe(1);
        expect(response.stderr).toContain("Unable to read the current identity for Edge Function 'api'");
        expect(writes).toBe(0);
    });

    test("creates deterministic archives with paths rooted at the output directory", async () => {
        const directory = await workspace();
        const first = await createFrontendArchive(join(directory, "dist"));
        const second = await createFrontendArchive(join(directory, "dist"));
        try {
            expect(first.sha256).toBe(second.sha256);
            const tar = await Bun.zstdDecompress(new Uint8Array(await readFile(first.archivePath)));
            const archive = await new Bun.Archive(tar).files();
            expect([...archive.keys()].sort()).toEqual(["assets/app.js", "index.html"]);
            expect(await archive.get("index.html")!.text()).toBe("<h1>hello</h1>\n");
            expect(first.archivePath.endsWith(".tar.zst")).toBe(true);
        } finally {
            await Promise.all([first.cleanup(), second.cleanup()]);
        }
    });

    test("builds the immutable release flow and prints the final URL", async () => {
        const directory = await workspace();
        const requests: string[] = [];
        let releaseId = "";
        let activationId = "";
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                const url = new URL(request.url);
                requests.push(`${request.method} ${url.pathname}${url.search}`);
                const base = "/v1/projects/abc123/frontend/deployments/web/releases";
                if (request.method === "GET" && url.pathname === "/v1/projects/abc123/frontend/deployments") {
                    return Response.json([deployment()]);
                }
                if (request.method === "GET" && url.pathname === "/v1/projects/abc123/frontend/deployments/web/active-release") {
                    return Response.json({
                        project_ref: "abc123",
                        deployment_id: "web",
                        active_release_id: releaseId || null,
                        active_activation_id: activationId || null,
                        releases: releaseId ? [release("abc123", "web", releaseId)] : [],
                        next_cursor: null,
                    });
                }
                if (request.method === "POST" && url.pathname === base) {
                    const bytes = new Uint8Array(await request.arrayBuffer());
                    releaseId = createHash("sha256").update(bytes).digest("hex");
                    return Response.json({
                        project_ref: "abc123",
                        deployment_id: "web",
                        release: release("abc123", "web", releaseId),
                    }, { status: 201 });
                }
                if (request.method === "GET" && url.pathname === `${base}/${releaseId}`) {
                    return Response.json({
                        project_ref: "abc123",
                        deployment_id: "web",
                        release: release("abc123", "web", releaseId),
                    });
                }
                if (request.method === "POST" && url.pathname === `${base}/${releaseId}/activate`) {
                    const body = await request.json() as Record<string, string>;
                    activationId = body.mutation_id;
                    return Response.json({
                        project_ref: "abc123",
                        deployment_id: "web",
                        active_release_id: releaseId,
                        activation_id: activationId,
                        release: release("abc123", "web", releaseId),
                        mutation: { mutation_id: activationId, status: "succeeded", replayed: false },
                    });
                }
                if (request.method === "GET" && url.pathname === "/v1/projects/abc123/frontend/deployments/web") {
                    return Response.json(deployment());
                }
                return new Response("not found", { status: 404 });
            },
        });
        servers.push(server);

        const response = await runCli(directory, `http://127.0.0.1:${server.port}`, [
            "deploy", "--skip_build", "--json",
        ]);

        expect(response.exitCode).toBe(0);
        expect(response.stderr).toBe("");
        const result = JSON.parse(response.stdout);
        expect(result).toMatchObject({
            ok: true,
            unchanged: false,
            project_ref: "abc123",
            deployment_id: "web",
            release_id: releaseId,
            activation_id: activationId,
            url: "https://web.example.com",
            file_count: 2,
            previous_release_id: null,
            previous_activation_id: null,
        });
        expect(requests).toEqual([
            "GET /v1/projects/abc123/frontend/deployments",
            "GET /v1/projects/abc123/frontend/deployments/web/active-release",
            "POST /v1/projects/abc123/frontend/deployments/web/releases",
            `GET /v1/projects/abc123/frontend/deployments/web/releases/${releaseId}`,
            `POST /v1/projects/abc123/frontend/deployments/web/releases/${releaseId}/activate`,
            "GET /v1/projects/abc123/frontend/deployments/web/active-release",
            `GET /v1/projects/abc123/frontend/deployments/web/releases/${releaseId}`,
            "GET /v1/projects/abc123/frontend/deployments/web",
        ]);
    });

    test("skips upload and activation when the content-addressed release is already active", async () => {
        const directory = await workspace();
        let writes = 0;
        let releaseId = "";
        let activationId = "";
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                const url = new URL(request.url);
                if (request.method !== "GET") writes++;
                const base = "/v1/projects/abc123/frontend/deployments/web/releases";
                if (request.method === "GET" && url.pathname === "/v1/projects/abc123/frontend/deployments") {
                    return Response.json([deployment()]);
                }
                if (request.method === "GET" && url.pathname === "/v1/projects/abc123/frontend/deployments/web/active-release") {
                    return Response.json({
                        project_ref: "abc123",
                        deployment_id: "web",
                        active_release_id: releaseId || null,
                        active_activation_id: activationId || null,
                        releases: releaseId ? [release("abc123", "web", releaseId)] : [],
                        next_cursor: null,
                    });
                }
                if (request.method === "POST" && url.pathname === base) {
                    const bytes = new Uint8Array(await request.arrayBuffer());
                    releaseId = createHash("sha256").update(bytes).digest("hex");
                    return Response.json({
                        project_ref: "abc123",
                        deployment_id: "web",
                        release: release("abc123", "web", releaseId),
                    }, { status: 201 });
                }
                if (request.method === "GET" && url.pathname === `${base}/${releaseId}`) {
                    return Response.json({
                        project_ref: "abc123",
                        deployment_id: "web",
                        release: release("abc123", "web", releaseId),
                    });
                }
                if (request.method === "POST" && url.pathname === `${base}/${releaseId}/activate`) {
                    const body = await request.json() as Record<string, string>;
                    activationId = body.mutation_id;
                    return Response.json({
                        project_ref: "abc123",
                        deployment_id: "web",
                        active_release_id: releaseId,
                        activation_id: activationId,
                        release: release("abc123", "web", releaseId),
                        mutation: { mutation_id: activationId, status: "succeeded", replayed: false },
                    });
                }
                if (request.method === "GET" && url.pathname === "/v1/projects/abc123/frontend/deployments/web") {
                    return Response.json(deployment());
                }
                return new Response("not found", { status: 404 });
            },
        });
        servers.push(server);

        const first = await runCli(directory, `http://127.0.0.1:${server.port}`, [
            "deploy", "--skip_build", "--json",
        ]);
        expect(first.exitCode).toBe(0);
        expect(writes).toBe(2);

        const response = await runCli(directory, `http://127.0.0.1:${server.port}`, [
            "deploy", "--skip_build", "--json",
        ]);

        expect(response.exitCode).toBe(0);
        expect(JSON.parse(response.stdout)).toMatchObject({
            ok: true,
            unchanged: true,
            release_id: releaseId,
        });
        expect(writes).toBe(2);
    });
});
