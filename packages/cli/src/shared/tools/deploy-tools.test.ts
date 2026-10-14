import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBuildEnvironment, createFrontendArchive, registerDeployTools } from "./deploy-tools";
import { registerFrontendTools } from "./frontend-tools";
import { registerDeveloperExperienceTools } from "./developer-experience-tools";
import { requireProjectDeploymentProtocol } from "./project-deployment";
import type { ToolInvocation, ToolResult } from "../tool-server";
import type { ToolSchema } from "../schema";
import { HttpTransport } from "../transports/http";

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../index.ts", import.meta.url));
const temporaryDirectories: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
const protocol = {
    protocol: "supacloud.project-deployment.v1", project_ref: "test-ref", environment_id: "test",
};

afterEach(async () => {
    for (const server of servers.splice(0)) server.stop(true);
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function workspace(config: object = { application: { id: "orders", environmentId: "test" } }) {
    const directory = await mkdtemp(join(tmpdir(), "supacloud-deploy-test-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "dist", "assets"), { recursive: true });
    await writeFile(join(directory, "dist", "index.html"), "<h1>hello</h1>\n");
    await writeFile(join(directory, "dist", "assets", "app.js"), "console.log('hello');\n");
    await writeFile(join(directory, "supacloud.json"), JSON.stringify(config));
    return directory;
}

function server(handler?: (request: Request) => Response | Promise<Response>) {
    const requests: string[] = [];
    const instance = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch(request) {
            const path = new URL(request.url).pathname;
            requests.push(`${request.method} ${path}`);
            return handler?.(request) ?? Response.json(protocol);
        },
    });
    servers.push(instance);
    return { requests, url: instance.url.origin, http: new HttpTransport({ baseUrl: instance.url.origin, token: "fixture" }) };
}

function deploy(http: HttpTransport, directory: string, options: {
    application?: { id: string; environmentId: string; configurationPath?: string; configurationId?: string };
    release?: (args: Record<string, unknown>) => Promise<ToolResult>;
} = {}) {
    let callback: ToolInvocation | undefined;
    let schema: ToolSchema | undefined;
    const calls: Record<string, unknown>[] = [];
    registerDeployTools({
        tool(_name, _description, shape, handler) { callback = handler; schema = shape; },
    }, http, {
        cwd: directory, projectRef: "test-ref", environment: "test",
        application: options.application,
        applicationRelease: async args => {
            calls.push(args);
            return options.release?.(args) ?? { content: [{ type: "text", text: '{"ok":true}' }] };
        },
    });
    return { run: (input: unknown = {}) => callback!(input), calls, schema };
}

async function runCli(directory: string, apiUrl: string, args: readonly string[], env: Record<string, string> = {}) {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
        !name.startsWith("SUPACLOUD_") && !name.startsWith("SUPABASE_")
        && !name.startsWith("MANAGEMENT_API_")
    )));
    const child = Bun.spawn([process.execPath, CLI_ENTRYPOINT, ...args], {
        cwd: directory,
        env: {
            ...environment, SUPACLOUD_API_URL: apiUrl, SUPACLOUD_API_TOKEN: "fixture",
            SUPACLOUD_PROJECT_REF: "test-ref", SUPACLOUD_ENV: "test", ...env,
        },
        stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
}

describe("current deployment only", () => {
    test("uses the repository application and selected environment, then delegates once", async () => {
        const directory = await workspace({ application: { id: "orders", environmentId: "production" } });
        const api = server();
        const tool = deploy(api.http, directory);
        await tool.run({ json: true });
        expect(tool.calls).toEqual([{
            action: "release", ref: "test-ref", id: "orders", environment_id: "test",
            root: directory, format: "json", json: true,
        }]);
        expect(api.requests).toEqual(["GET /v1/projects/test-ref/environments/test/deployments/protocol"]);
    });

    test("profile binding needs neither frontend configuration nor a local configuration revision", async () => {
        const directory = await workspace({});
        const api = server();
        const tool = deploy(api.http, directory, { application: { id: "orders", environmentId: "test" } });
        await tool.run();
        expect(tool.calls).toHaveLength(1);
        expect(tool.calls[0]).not.toHaveProperty("configuration_id");
        expect(tool.calls[0]).not.toHaveProperty("web_release");
    });

    test("initialization makes application binding optional for static assets", async () => {
        const directory = await workspace();
        await rm(join(directory, "supacloud.json"));
        const tools = new Map<string, ToolInvocation>();
        registerDeveloperExperienceTools({
            tool(name, _description, _schema, handler) { tools.set(name, handler); },
        });
        const result = await tools.get("init")!({ root: directory, json: true });
        expect(result.content[0]?.text).toContain("SUPACLOUD_APPLICATION_ID");
        expect(await readFile(join(directory, ".env.supacloud.test.example"), "utf8"))
            .toContain("# Optional for executable application delivery: SUPACLOUD_APPLICATION_ID=<application-id>");
    });

    test.each([
        { application: { id: "orders", environmentId: "test" } },
        { frontend: { outputDirectory: "dist" } },
    ])("environment inspection accepts application or standalone frontend configuration: %j", async config => {
        const directory = await workspace(config);
        await writeFile(join(directory, ".env.supacloud.test"), [
            "SUPACLOUD_ENV=test", "SUPACLOUD_API_URL=https://management.example.com",
            "SUPACLOUD_API_TOKEN=private-profile-token", "SUPACLOUD_PROJECT_REF=test-ref",
        ].join("\n"));
        const tools = new Map<string, ToolInvocation>();
        registerDeveloperExperienceTools({
            tool(name, _description, _schema, handler) { tools.set(name, handler); },
        });
        const result = await tools.get("env")!({ action: "check", root: directory, json: true });
        expect(JSON.parse(result.content[0]!.text)).toMatchObject({
            environments: [{ deployReady: true, deployMissing: [] }],
        });
        expect(result.content[0]?.text).not.toContain("private-profile-token");
    });

    test.each(["target", "id", "build_command", "output_dir", "plan", "diff", "dry_run"])(
        "rejects removed %s even when false, before HTTP or delegation", async flag => {
            const directory = await workspace();
            const api = server();
            const tool = deploy(api.http, directory);
            await expect(tool.run({ [flag]: false })).rejects.toThrow("DEPLOYMENT_UPGRADE_REQUIRED");
            expect(tool.schema).not.toHaveProperty(flag);
            expect(tool.calls).toEqual([]);
            expect(api.requests).toEqual([]);
        },
    );

    test.each([
        {},
        { targets: { api: { type: "edge_function", root: "." } } },
    ])("rejects standalone deployment configuration without guessing an application: %j", async config => {
        const directory = await workspace(config);
        const api = server();
        const tool = deploy(api.http, directory);
        await expect(tool.run({ skip_build: true })).rejects.toThrow("supacloud deploy");
        expect(api.requests).toEqual([]);
        expect(tool.calls).toEqual([]);
    });

    test("rejects a historical release manifest before any remote access", async () => {
        const directory = await workspace();
        await writeFile(join(directory, "deploy-manifest.json"), "{}");
        const api = server();
        await expect(deploy(api.http, directory).run()).rejects.toThrow("DEPLOYMENT_UPGRADE_REQUIRED");
        expect(api.requests).toEqual([]);
    });

    test("does not silently discard standalone Function targets in an application", async () => {
        const directory = await workspace({
            application: { id: "orders" }, targets: { api: { type: "edge_function", root: "." } },
        });
        const api = server();
        await expect(deploy(api.http, directory).run()).rejects.toThrow("PROJECT_DEPLOYMENT_UNSUPPORTED");
        expect(api.requests).toEqual([]);
    });

    test("rejects conflicting configuration sources before remote access", async () => {
        const directory = await workspace();
        const api = server();
        const tool = deploy(api.http, directory, {
            application: { id: "orders", environmentId: "test", configurationId: "id", configurationPath: "path" },
        });
        await expect(tool.run()).rejects.toThrow("only one");
        expect(api.requests).toEqual([]);
    });

    test.each([
        { status: 404, data: {} }, { status: 200, data: { ...protocol, protocol: "old" } },
        { status: 200, data: { ...protocol, environment_id: "production" } },
        { status: 200, data: { ...protocol, project_ref: "other" } },
    ])("fails closed on a missing, old or cross-environment protocol: %j", async scenario => {
        const directory = await workspace({
            application: { id: "orders" },
            frontend: { buildCommand: "touch build-ran", outputDirectory: "dist" },
        });
        const api = server(() => Response.json(scenario.data, { status: scenario.status }));
        const tool = deploy(api.http, directory);
        await expect(tool.run()).rejects.toThrow("DEPLOYMENT_PROTOCOL_MISMATCH");
        expect(api.requests).toHaveLength(1);
        expect(tool.calls).toEqual([]);
        await expect(readFile(join(directory, "build-ran"))).rejects.toThrow();
    });

    test.each([401, 403, 429, 503])("does not mislabel HTTP %s as a version mismatch or retry", async status => {
        const api = server(() => Response.json({}, { status }));
        await expect(requireProjectDeploymentProtocol(api.http, "test-ref", "test"))
            .rejects.toThrow("DEPLOYMENT_PROTOCOL_UNAVAILABLE");
        expect(api.requests).toHaveLength(1);
    });

    test("an unreadable protocol response stops before any write", async () => {
        const api = server(() => Response.json(null));
        await expect(requireProjectDeploymentProtocol(api.http, "test-ref", "test"))
            .rejects.toThrow("DEPLOYMENT_PROTOCOL_UNAVAILABLE");
        expect(api.requests).toHaveLength(1);
    });

    test.each(["deploy_git", "deploy_upload", "redeploy", "upload_release", "activate_release"])(
        "removes frontend %s from metadata and rejects it before HTTP", async action => {
            const api = server();
            let callback: ToolInvocation | undefined;
            let shape: ToolSchema | undefined;
            registerFrontendTools({
                tool(_name, _description, schema, handler) { callback = handler; shape = schema; },
            }, api.http);
            expect(JSON.stringify(shape)).not.toContain(`"${action}"`);
            await expect(callback!({ action })).rejects.toThrow("npm install -g @supacloud/cli@latest");
            expect(api.requests).toEqual([]);
        },
    );

    test.each([
        { args: ["deploy", "--target=web"] }, { args: ["deploy", "--plan"] },
        { args: ["frontend", "upload_release", "--archive_path", "does-not-exist"] },
    ])("CLI gives upgrade guidance for removed invocation %j", async ({ args }) => {
        const directory = await workspace();
        const api = server();
        const result = await runCli(directory, api.url, args);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("DEPLOYMENT_UPGRADE_REQUIRED");
        expect(api.requests).toEqual([]);
    });

    test("retains read-only and production confirmation protection before protocol reads", async () => {
        const directory = await workspace();
        const api = server();
        const environments: Record<string, string>[] = [
            { SUPACLOUD_READ_ONLY: "true" }, { SUPACLOUD_ENV: "production" },
        ];
        for (const env of environments) {
            const result = await runCli(directory, api.url, ["deploy"], env);
            expect(result.exitCode).toBe(1);
        }
        expect(api.requests).toEqual([]);
    });

    test("uploads one bound Web artifact without reading CAS or activating from the CLI", async () => {
        const directory = await workspace({
            application: { id: "orders" }, frontend: { id: "web", root: ".", outputDirectory: "dist" },
        });
        const archive = await createFrontendArchive(join(directory, "dist"));
        const release = {
            schema: "supacloud.frontend-release.v2", project_ref: "test-ref", deployment_id: "web",
            release_id: archive.sha256, sha256: archive.sha256, tree_sha256: archive.treeSha256,
            size_bytes: archive.archiveBytes, file_count: archive.fileCount,
            created_at: "2026-10-13T00:00:00.000Z", kind: "prebuilt_static", archive_format: "tar.zst",
        };
        await archive.cleanup();
        const api = server(async request => {
            const path = new URL(request.url).pathname;
            if (path.endsWith("/protocol")) return Response.json(protocol);
            if (request.method === "GET" && path.endsWith("/frontend/deployments")) {
                return Response.json([{ id: "web", name: "web", framework: "static", output_dir: "dist" }]);
            }
            if (request.method === "POST" && path.endsWith("/deployments/web-release")) {
                expect(new URL(request.url).searchParams.get("deployment_id")).toBe("web");
                expect((await request.arrayBuffer()).byteLength).toBe(release.size_bytes);
                return Response.json({
                    ok: true, project_ref: "test-ref", environment_id: "test",
                    deployment_id: "web", release_id: release.release_id, release,
                }, { status: 201 });
            }
            return new Response("Unexpected legacy request", { status: 400 });
        });
        const tool = deploy(api.http, directory);
        await tool.run({ skip_build: true, json: true });
        expect(tool.calls).toHaveLength(1);
        expect(tool.calls[0]?.web_release).toEqual({ deployment_id: "web", release_id: release.release_id });
        expect(api.requests).toEqual([
            "GET /v1/projects/test-ref/environments/test/deployments/protocol",
            "GET /v1/projects/test-ref/frontend/deployments",
            "POST /v1/projects/test-ref/environments/test/deployments/web-release",
        ]);
    });

    test.each(["static", "mixed", "initial", "conflict", "unknown", "unchanged", "tree-mismatch"] as const)(
        "assets-only publication preserves backend boundaries: %s", async mode => {
            const directory = await workspace({
                ...(mode === "mixed" ? { application: { id: "orders" },
                    targets: {
                        api: { type: "edge_function", root: "." },
                        web: { type: "frontend", root: ".", id: "web", outputDirectory: "dist" },
                    },
                } : { frontend: { id: "web", root: ".", outputDirectory: "dist" } }),
            });
            if (mode === "mixed") {
                await mkdir(join(directory, "supacloud", "fa"), { recursive: true });
                await writeFile(join(directory, "supacloud", "fa", "deploy-manifest.json"), '{"keep":true}');
            }
            const archive = await createFrontendArchive(join(directory, "dist"));
            const release = {
                schema: "supacloud.frontend-release.v2", project_ref: "test-ref", deployment_id: "web",
                release_id: archive.sha256, sha256: archive.sha256, tree_sha256: archive.treeSha256,
                size_bytes: archive.archiveBytes, file_count: archive.fileCount,
                created_at: "2026-10-14T00:00:00.000Z", kind: "prebuilt_static", archive_format: "tar.zst",
            };
            await archive.cleanup();
            const previous = { ...release, release_id: "a".repeat(64), sha256: "a".repeat(64),
                tree_sha256: mode === "unchanged" ? release.tree_sha256 : "b".repeat(64) };
            let active = previous;
            const previousActivation = crypto.randomUUID();
            let activationId: string = previousActivation;
            let activations = 0;
            const base = "/v1/projects/test-ref/frontend/deployments/web";
            const api = server(async request => {
                const path = new URL(request.url).pathname;
                if (path.endsWith("/protocol")) return Response.json(protocol);
                if (request.method === "GET" && path.endsWith("/frontend/deployments")) {
                    return Response.json([{ id: "web", name: "web", framework: "static", output_dir: "dist" }]);
                }
                if (request.method === "GET" && path === `${base}/active-release`) {
                    return Response.json({
                        project_ref: "test-ref", deployment_id: "web",
                        active_release_id: mode === "initial" && activations === 0 ? null : active.release_id,
                        active_activation_id: mode === "initial" && activations === 0 ? null : activationId,
                        releases: mode === "initial" && activations === 0 ? [] : [active], next_cursor: null,
                    });
                }
                if (path === `${base}/releases` && request.method === "POST") {
                    expect((await request.arrayBuffer()).byteLength).toBe(release.size_bytes);
                    return Response.json({ project_ref: "test-ref", deployment_id: "web",
                        release: mode === "tree-mismatch" ? { ...release, tree_sha256: "c".repeat(64) } : release,
                    }, { status: 201 });
                }
                if (path === `${base}/releases/${release.release_id}` && request.method === "GET") {
                    return Response.json({ project_ref: "test-ref", deployment_id: "web", release });
                }
                if (path === `${base}/releases/${release.release_id}/activate` && request.method === "POST") {
                    activations++;
                    const body = await request.json() as Record<string, unknown>;
                    expect(body.expected_active_release_id).toBe(mode === "initial" ? "absent" : previous.release_id);
                    expect(body.expected_activation_id).toBe(mode === "initial" ? "absent" : previousActivation);
                    expect(typeof body.mutation_id).toBe("string");
                    if (mode === "conflict") return Response.json({ code: "CONFLICT" }, { status: 409 });
                    active = release;
                    activationId = String(body.mutation_id);
                    if (mode === "unknown") return Response.json({}, { status: 503 });
                    return Response.json({
                        project_ref: "test-ref", deployment_id: "web",
                        active_release_id: release.release_id, activation_id: activationId, release,
                        mutation: { mutation_id: activationId, status: "succeeded", replayed: false },
                    });
                }
                return Response.json({ code: "UNEXPECTED_REQUEST" }, { status: 404 });
            });
            const tool = deploy(api.http, directory);
            const result = await tool.run({ skip_build: true, ...(mode === "mixed" ? { assets_only: true } : {}) });
            const receipt = JSON.parse(result.content[0]!.text);
            expect(tool.calls).toEqual([]);
            expect(activations).toBe(mode === "unchanged" || mode === "tree-mismatch" ? 0 : 1);
            if (mode === "conflict" || mode === "unknown") {
                expect(result.isError).toBe(true);
                expect(receipt.mutation_id).toBeString();
                expect(receipt.target_release_id).toBe(release.release_id);
                expect(receipt.error.code).toBe(mode === "unknown" ? "OUTCOME_UNKNOWN" : "HTTP_ERROR");
            } else if (mode === "tree-mismatch") {
                expect(result.isError).toBe(true);
            } else {
                expect(result.isError).not.toBe(true);
                expect(receipt.active_release_id).toBe(mode === "unchanged" ? previous.release_id : release.release_id);
            }
            if (mode === "mixed") {
                expect(await readFile(join(directory, "supacloud", "fa", "deploy-manifest.json"), "utf8"))
                    .toBe('{"keep":true}');
            }
            expect(api.requests.every(path => path.includes("/frontend/") || path.endsWith("/protocol")
                || (mode === "unknown" && path.includes("/mutations/")))).toBe(true);
        },
    );

    test("assets-only requires explicit frontend configuration before remote access", async () => {
        const directory = await workspace();
        const api = server();
        await expect(deploy(api.http, directory).run({ assets_only: true })).rejects.toThrow("frontend configuration");
        expect(api.requests).toEqual([]);
    });

    test("mixed frontend repositories require explicit assets-only selection", async () => {
        const directory = await workspace({ frontend: { outputDirectory: "dist" } });
        await writeFile(join(directory, "deploy-manifest.json"), "{}");
        const api = server();
        await expect(deploy(api.http, directory).run({ skip_build: true })).rejects.toThrow("DEPLOYMENT_UPGRADE_REQUIRED");
        expect(api.requests).toEqual([]);
    });

    test("assets-only retains production, read-only and target guards", async () => {
        const directory = await workspace({ frontend: { outputDirectory: "dist" } });
        const api = server();
        const guardEnvironments: Array<Record<string, string>> = [
            { SUPACLOUD_READ_ONLY: "true" }, { SUPACLOUD_ENV: "production" },
        ];
        for (const env of guardEnvironments) {
            const result = await runCli(directory, api.url, ["deploy", "--assets_only"], env);
            expect(result.exitCode).toBe(1);
            expect(result.stderr).toContain(env.SUPACLOUD_READ_ONLY ? "read-only" : "--confirm-production");
        }
        const foreign = await runCli(directory, api.url, [
            "deploy", "--assets_only", "--ref", "foreign", "--confirm-production", "foreign",
        ], { SUPACLOUD_ENV: "production" });
        expect(foreign.exitCode).toBe(1);
        expect(foreign.stderr).toContain("cannot target a different project");
        expect(api.requests).toEqual([]);
    });

    test("keeps sensitive build variables out and reports missing names without values", () => {
        const build = createBuildEnvironment(["VITE_API_URL", "PUBLIC_MISSING"], {
            VITE_API_URL: "https://test.example.com", SUPACLOUD_API_TOKEN: "private-token",
            SUPABASE_SERVICE_ROLE_KEY: "private-key",
        });
        expect(build.env.VITE_API_URL).toBe("https://test.example.com");
        expect(build.env.SUPACLOUD_API_TOKEN).toBeUndefined();
        expect(build.env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
        expect(build.missing).toEqual(["PUBLIC_MISSING"]);
    });

    test("rejects credential allowlists before HTTP", async () => {
        const directory = await workspace({
            application: { id: "orders" }, frontend: { buildEnv: ["SUPACLOUD_API_TOKEN"] },
        });
        const api = server();
        await expect(deploy(api.http, directory).run()).rejects.toThrow("sensitive variable");
        expect(api.requests).toEqual([]);
    });

    test("creates deterministic archives and rejects symlink contents", async () => {
        const directory = await workspace();
        const first = await createFrontendArchive(join(directory, "dist"));
        const second = await createFrontendArchive(join(directory, "dist"));
        try {
            expect(first.sha256).toBe(second.sha256);
            expect(first.treeSha256).toBe(second.treeSha256);
            expect(first.fileCount).toBe(2);
            expect(await readFile(first.archivePath)).toEqual(await readFile(second.archivePath));
        } finally {
            await first.cleanup();
            await second.cleanup();
        }
        await symlink(join(directory, "supacloud.json"), join(directory, "dist", "secret"));
        await expect(createFrontendArchive(join(directory, "dist"))).rejects.toThrow("symbolic links");
    });
});
