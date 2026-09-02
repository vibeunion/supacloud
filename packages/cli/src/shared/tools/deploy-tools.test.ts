import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
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
        schema: "supacloud.frontend-release.v1",
        project_ref: projectRef,
        deployment_id: deploymentId,
        release_id: releaseId,
        sha256: releaseId,
        tree_sha256: "b".repeat(64),
        size_bytes: 128,
        file_count: 2,
        created_at: "2026-09-02T08:00:00.000Z",
        kind: "prebuilt_static",
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

async function runCli(directory: string, apiUrl: string, args: string[]) {
    const child = Bun.spawn([process.execPath, CLI_ENTRYPOINT, ...args], {
        cwd: directory,
        env: {
            ...process.env,
            SUPACLOUD_API_URL: apiUrl,
            SUPACLOUD_API_TOKEN: "test-token",
            SUPACLOUD_PROJECT_REF: "abc123",
            SUPACLOUD_ENV: "test",
        },
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

describe("one-command frontend deploy", () => {
    test("creates deterministic archives with paths rooted at the output directory", async () => {
        const directory = await workspace();
        const first = await createFrontendArchive(join(directory, "dist"));
        const second = await createFrontendArchive(join(directory, "dist"));
        try {
            expect(first.sha256).toBe(second.sha256);
            const archive = unzipSync(new Uint8Array(await readFile(first.archivePath)));
            expect(Object.keys(archive).sort()).toEqual(["assets/app.js", "index.html"]);
            expect(new TextDecoder().decode(archive["index.html"])).toBe("<h1>hello</h1>\n");
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
                if (request.method === "GET" && url.pathname === base) {
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
        });
        expect(requests).toEqual([
            "GET /v1/projects/abc123/frontend/deployments",
            "GET /v1/projects/abc123/frontend/deployments/web/releases?limit=100",
            "POST /v1/projects/abc123/frontend/deployments/web/releases",
            `GET /v1/projects/abc123/frontend/deployments/web/releases/${releaseId}`,
            `POST /v1/projects/abc123/frontend/deployments/web/releases/${releaseId}/activate`,
            "GET /v1/projects/abc123/frontend/deployments/web/releases?limit=100",
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
                if (request.method === "GET" && url.pathname === base) {
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
