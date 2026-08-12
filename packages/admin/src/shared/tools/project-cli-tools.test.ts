import { afterEach, describe, expect, test } from "bun:test";
import {
    chmodSync,
    constants,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { registerAdminProjectCliTools, registerUserProjectCliTools } from "./project-cli-tools";
import { schemaEnumValues } from "../schema";
import type { ToolSchema } from "../schema";
import type { ProjectEnvFileOperations } from "./project-create-env";
import type { ProjectRuntimeSnapshot } from "./project-runtime-snapshot";

type ProjectCallback = (
    args: Record<string, unknown>,
) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

type ProjectToolRegistration = {
    callback: ProjectCallback;
    schema: ToolSchema;
};

const CREATE_PROJECT_REF = "abcdefghijklmnopqrst";
const CREATE_FUTURE_EXPIRATION = 4_102_444_800;
const RUNTIME_REVISION = `hmac-sha256:${"a".repeat(64)}`;
const createSandboxes: string[] = [];

function testProjectEnvFileOperations(): ProjectEnvFileOperations {
    const directoryPaths = new WeakMap<object, string>();
    return {
        platform: "linux",
        effectiveUid: () => process.geteuid?.() ?? -1,
        lstat,
        realpath,
        async openDirectory(path) {
            const openDirectory = await open(path, constants.O_RDONLY);
            const directoryHandle = {
                fd: openDirectory.fd,
                stat: () => openDirectory.stat(),
                sync: async () => {},
                close: () => openDirectory.close(),
            };
            directoryPaths.set(directoryHandle, path);
            return directoryHandle;
        },
        openExclusiveAt: (directory, filename, mode) =>
            open(join(directoryPaths.get(directory)!, filename), "wx", mode),
        lstatAt: (directory, filename) => lstat(join(directoryPaths.get(directory)!, filename)),
        unlinkAt: (directory, filename) => unlink(join(directoryPaths.get(directory)!, filename)),
    };
}

const defaultProjectEnvFileOperations = testProjectEnvFileOperations();

function createJwtSegment(claims: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
}

const CREATE_SERVICE_ROLE_KEY = [
    createJwtSegment({ alg: "HS256", typ: "JWT" }),
    createJwtSegment({
        role: "service_role",
        iss: "supabase",
        exp: CREATE_FUTURE_EXPIRATION,
    }),
    "s".repeat(43),
].join(".");

function createSandbox(): string {
    const path = realpathSync(mkdtempSync(join(homedir(), ".supacloud-admin-create-")));
    createSandboxes.push(path);
    return path;
}

function createResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        ref: CREATE_PROJECT_REF,
        name: "secure-project",
        api: { url: "https://api.example.test" },
        credentials: { service_role_key: CREATE_SERVICE_ROLE_KEY },
        ...overrides,
    };
}

afterEach(() => {
    for (const path of createSandboxes.splice(0)) rmSync(path, { recursive: true, force: true });
});

const REMOTE_RESPONSE_DETAILS = [
    "remote-token-value",
    "remote-secret-value",
    "Bearer remote-authorization",
    "hidden-project-ref",
    "remote free text",
    '"token"',
    '"secret"',
    '"Authorization"',
] as const;

function expectNoRemoteResponseDetails(output: string): void {
    for (const detail of REMOTE_RESPONSE_DETAILS) {
        expect(output).not.toContain(detail);
    }
}

function studioServiceInventory(
    projectRef = "project-ref",
    authRuntimeRef = projectRef,
): Array<Record<string, unknown>> {
    return [
        { id: "db", name: "db", status: "ACTIVE_HEALTHY", healthy: true,
            service_host_ids: [`${projectRef}-db`] },
        { id: "rest", name: "rest", status: "COMING_UP", healthy: false,
            service_host_ids: [`${projectRef}-rest`] },
        { id: "auth", name: "auth", status: "INACTIVE", healthy: false,
            service_host_ids: [`${authRuntimeRef}-auth`] },
        { id: "realtime", name: "realtime", status: "UNHEALTHY", healthy: false,
            service_host_ids: [`${projectRef}-realtime`] },
        { id: "storage", name: "storage", status: "ACTIVE_HEALTHY", healthy: true,
            service_host_ids: [`${projectRef}-storage`] },
    ];
}

function runtimeSnapshot(projectRef = "project-ref"): ProjectRuntimeSnapshot {
    return {
        schema: "supacloud.runtime-snapshot.v1",
        project_ref: projectRef,
        captured_at: "2026-08-11T00:00:00.000Z",
        secrets: {
            desired_revision: RUNTIME_REVISION,
            loaded_revision: RUNTIME_REVISION,
            load_state: "current",
            load_source: "management_api",
            matches_desired: true,
            loaded_at: "2026-08-11T00:00:00.000Z",
        },
        postgrest: {
            desired_revision: RUNTIME_REVISION,
            loaded_revision: RUNTIME_REVISION,
            attestation_state: "loaded",
            matches_desired: true,
            desired: "running",
            actual: "running",
            health: "healthy",
            port: 3101,
            unit: `supacloud-pgrst@${projectRef}`,
            loaded_at: "2026-08-11T00:00:00.000Z",
        },
    };
}

async function expectInvalidInventory(
    inventory: unknown,
    projectRef = "project-ref",
): Promise<void> {
    const projectCallback = captureAdminProjectTool({
        get: async () => ({ ok: true, status: 200, data: inventory }),
    });

    const response = await projectCallback({ action: "services", ref: projectRef });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toBe("❌ Project service inventory response is invalid");
}

async function expectInvalidRuntimeSnapshot(payload: unknown): Promise<void> {
    const projectCallback = captureAdminProjectTool({
        get: async () => ({ ok: true, status: 200, data: payload }),
    });

    const response = await projectCallback({ action: "runtime_snapshot", ref: "project-ref" });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toBe("❌ Project runtime snapshot response is invalid");
}

function captureAdminProjectRegistration(
    http: Record<string, unknown>,
    options: { projectEnvFileOperations?: ProjectEnvFileOperations } = {},
): ProjectToolRegistration {
    let registration: ProjectToolRegistration | undefined;
    registerAdminProjectCliTools({
        tool(name: string, _description: string, schema: ToolSchema, callback: ProjectCallback) {
            if (name === "project") registration = { callback, schema };
        },
    }, http as any, {
        projectEnvFileOperations: options.projectEnvFileOperations ?? defaultProjectEnvFileOperations,
    });

    if (!registration) throw new Error("admin project tool was not registered");
    return registration;
}

function captureAdminProjectTool(
    http: Record<string, unknown>,
    options: { projectEnvFileOperations?: ProjectEnvFileOperations } = {},
): ProjectCallback {
    return captureAdminProjectRegistration(http, options).callback;
}

function captureUserProjectTool(http: Record<string, unknown>, projectRef: string): ProjectCallback {
    let projectCallback: ProjectCallback | undefined;
    registerUserProjectCliTools({
        tool(name: string, _description: string, _schema: ToolSchema, callback: ProjectCallback) {
            if (name === "project") projectCallback = callback;
        },
    }, http as any, { projectRef });
    if (!projectCallback) throw new Error("user project tool was not registered");
    return projectCallback;
}

describe("admin project reads", () => {
    test("wires Admin and user reads through bounded credential-safe projections", async () => {
        const remoteSecret = "wired-project-private-sentinel";
        const summary = {
            id: "11111111-1111-4111-8111-111111111111",
            ref: CREATE_PROJECT_REF,
            organization_id: "22222222-2222-4222-8222-222222222222",
            organization_slug: "example-organization",
            name: "Example project",
            region: "local",
            created_at: "2026-08-12T00:00:00.000Z",
            status: "ACTIVE_HEALTHY",
        };
        const requests: Array<{ path: string; maxResponseBytes: number | undefined }> = [];
        const http = {
            get: async (path: string, options?: { maxResponseBytes?: number }) => {
                requests.push({ path, maxResponseBytes: options?.maxResponseBytes });
                return path === "/v1/projects"
                    ? { ok: true, status: 200, data: [summary] }
                    : {
                        ok: true,
                        status: 200,
                        data: {
                            ...summary,
                            database: {
                                host: "db.example.test",
                                version: "17.5",
                                postgres_engine: "17",
                                release_channel: "stable",
                            },
                            api: { url: "https://api.example.test" },
                            studio: { url: "https://studio.example.test" },
                            config: { private_runtime_value: remoteSecret },
                            anon_key: remoteSecret,
                            services: [{ token: remoteSecret }],
                        },
                    };
            },
        };
        const projectCallback = captureAdminProjectTool(http);
        const userProjectCallback = captureUserProjectTool(http, CREATE_PROJECT_REF);

        const listResponse = await projectCallback({ action: "list" });
        const getResponse = await projectCallback({ action: "get", ref: CREATE_PROJECT_REF });
        const userGetResponse = await userProjectCallback({ action: "get" });

        expect(JSON.parse(listResponse.content[0].text)).toEqual([summary]);
        expect(JSON.parse(getResponse.content[0].text)).toEqual({
            ...summary,
            database: {
                host: "db.example.test",
                version: "17.5",
                postgres_engine: "17",
                release_channel: "stable",
            },
            api: { url: "https://api.example.test" },
            studio: { url: "https://studio.example.test" },
        });
        expect(userGetResponse.content[0].text).toBe(getResponse.content[0].text);
        expect(requests).toEqual([
            { path: "/v1/projects", maxResponseBytes: 1_048_576 },
            { path: `/v1/projects/${CREATE_PROJECT_REF}`, maxResponseBytes: 1_048_576 },
            { path: `/v1/projects/${CREATE_PROJECT_REF}`, maxResponseBytes: 1_048_576 },
        ]);
        expect(
            listResponse.content[0].text + getResponse.content[0].text + userGetResponse.content[0].text,
        ).not.toContain(remoteSecret);
    });

    test("marks malformed Admin and user reads as tool errors without reflection", async () => {
        const remoteSecret = "invalid-wired-project-sentinel";
        const http = {
            get: async () => ({
                ok: true,
                status: 200,
                data: {
                    id: "11111111-1111-4111-8111-111111111111",
                    ref: CREATE_PROJECT_REF,
                    organization_id: "22222222-2222-4222-8222-222222222222",
                    organization_slug: "example-organization",
                    name: "Example project",
                    region: "local",
                    created_at: "2026-08-12T00:00:00.000Z",
                    status: "ACTIVE_HEALTHY",
                    database: {
                        host: "db.example.test",
                        version: "17.5",
                        postgres_engine: "17",
                        release_channel: "stable",
                    },
                    credentials: { service_role_key: remoteSecret },
                },
            }),
        };
        const adminResponse = await captureAdminProjectTool(http)({
            action: "get",
            ref: CREATE_PROJECT_REF,
        });
        const userResponse = await captureUserProjectTool(http, CREATE_PROJECT_REF)({ action: "get" });

        for (const response of [adminResponse, userResponse]) {
            expect(response.isError).toBe(true);
            expect(response.content[0].text).toBe("❌ Invalid project response");
            expect(response.content[0].text).not.toContain(remoteSecret);
        }
    });
});

describe("admin project create", () => {
    test("declares only test and production for local credential profiles", () => {
        const { schema } = captureAdminProjectRegistration({});

        expect(schemaEnumValues(schema.environment)).toEqual(["test", "production"]);
    });

    test("forwards every non-empty custom domain unchanged", async () => {
        const requests: Array<{ path: string; body: unknown }> = [];
        const projectCallback = captureAdminProjectTool({
            post: async (path: string, body: unknown) => {
                requests.push({ path, body });
                return { ok: true, status: 201, data: { ref: "project-ref" } };
            },
        });

        await projectCallback({
            action: "create",
            name: "domain-project",
            region: "ap-southeast-1",
            organization_id: "organization-id",
            domain: "Example.COM",
            api_domain: "API.Example.COM",
            auth_domain: "Auth.Example.COM",
            studio_domain: "Studio.Example.COM",
        });

        expect(requests).toEqual([{
            path: "/v1/projects",
            body: {
                name: "domain-project",
                region: "ap-southeast-1",
                organization_id: "organization-id",
                domain: "Example.COM",
                api_domain: "API.Example.COM",
                auth_domain: "Auth.Example.COM",
                studio_domain: "Studio.Example.COM",
            },
        }]);
    });

    test("omits empty custom domain flags from the create request", async () => {
        let createRequest: Record<string, unknown> | undefined;
        const projectCallback = captureAdminProjectTool({
            post: async (_path: string, body: Record<string, unknown>) => {
                createRequest = body;
                return { ok: true, status: 201, data: { ref: "project-ref" } };
            },
        });

        await projectCallback({
            action: "create",
            name: "default-domain-project",
            domain: "",
            api_domain: "",
            auth_domain: "",
            studio_domain: "",
        });

        if (!createRequest) throw new Error("project create request was not captured");
        expect(createRequest.name).toBe("default-domain-project");
        expect(createRequest.region).toBe("local");
        expect("domain" in createRequest).toBe(false);
        expect("api_domain" in createRequest).toBe(false);
        expect("auth_domain" in createRequest).toBe(false);
        expect("studio_domain" in createRequest).toBe(false);
    });

    test("writes one-time credentials to a new 0600 env file and emits only a safe receipt", async () => {
        const remoteSecret = "remote-create-secret";
        const directory = createSandbox();
        const envFile = join(directory, ".env.project-credentials.test");
        let createRequest: Record<string, unknown> | undefined;
        const projectCallback = captureAdminProjectTool({
            post: async (_path: string, body: Record<string, unknown>) => {
                createRequest = body;
                return {
                    ok: true,
                    status: 201,
                    data: createResponse({
                        jwt_secret: remoteSecret,
                        db_password: remoteSecret,
                        secret_key: remoteSecret,
                        credentials: {
                            service_role_key: CREATE_SERVICE_ROLE_KEY,
                            jwt_secret: remoteSecret,
                        },
                    }),
                };
            },
        });

        const response = await projectCallback({
            action: "create",
            name: "secure-project",
            api_domain: "api.example.test",
            env_file: envFile,
            environment: "test",
        });
        const receipt = JSON.parse(response.content[0].text);

        expect(response.isError).not.toBe(true);
        expect(createRequest).toEqual(expect.objectContaining({
            name: "secure-project",
            credential_delivery: "response",
        }));
        expect(receipt).toEqual({
            schema: "supacloud.cli.release-control.v1",
            ok: true,
            operation: "project.create",
            project_ref: CREATE_PROJECT_REF,
            api_url: "https://api.example.test",
            credentials_written: true,
            env_file: envFile,
            env_file_scope: "project_application",
        });
        expect(response.content[0].text).not.toContain(CREATE_SERVICE_ROLE_KEY);
        expect(response.content[0].text).not.toContain(remoteSecret);
        expect(readFileSync(envFile, "utf8")).toContain(
            `SUPABASE_SERVICE_ROLE_KEY=${CREATE_SERVICE_ROLE_KEY}`,
        );
        expect(readFileSync(envFile, "utf8")).toContain("SUPACLOUD_ENV=test");
        if (process.platform !== "win32") expect(statSync(envFile).mode & 0o777).toBe(0o600);
    });

    test("rejects a credential response on an unrequested non-default API port", async () => {
        const directory = createSandbox();
        const envFile = join(directory, "wrong-origin.env");
        const projectCallback = captureAdminProjectTool({
            post: async () => ({
                ok: true,
                status: 201,
                data: createResponse({
                    name: "wrong-origin-project",
                    api: { url: "https://api.example.test:8443" },
                }),
            }),
        });

        const response = await projectCallback({
            action: "create",
            name: "wrong-origin-project",
            api_domain: "api.example.test",
            env_file: envFile,
            environment: "test",
        });

        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).error.code).toBe("OUTCOME_UNKNOWN");
        expect(response.content[0].text).not.toContain(CREATE_SERVICE_ROLE_KEY);
        expect(() => readFileSync(envFile, "utf8")).toThrow();
    });

    test("rejects stale credentials for a different project name", async () => {
        const directory = createSandbox();
        const envFile = join(directory, "stale-name.env");
        const projectCallback = captureAdminProjectTool({
            post: async () => ({
                ok: true,
                status: 201,
                data: createResponse({ name: "different-project" }),
            }),
        });

        const response = await projectCallback({
            action: "create",
            name: "secure-project",
            api_domain: "api.example.test",
            env_file: envFile,
            environment: "test",
        });

        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).error.code).toBe("INVALID_RESPONSE");
        expect(response.content[0].text).not.toContain(CREATE_SERVICE_ROLE_KEY);
        expect(existsSync(envFile)).toBe(false);
    });

    test("keeps default create output credential-free without requesting delivery", async () => {
        let createRequest: Record<string, unknown> | undefined;
        const projectCallback = captureAdminProjectTool({
            post: async (_path: string, body: Record<string, unknown>) => {
                createRequest = body;
                return {
                    ok: true,
                    status: 201,
                    data: {
                        ref: CREATE_PROJECT_REF,
                        api: { url: `https://${CREATE_PROJECT_REF}.api.example.test` },
                        jwt_secret: "ignored-secret",
                    },
                };
            },
        });

        const response = await projectCallback({ action: "create", name: "safe-default" });
        const receipt = JSON.parse(response.content[0].text);

        expect(response.isError).not.toBe(true);
        expect(createRequest).not.toHaveProperty("credential_delivery");
        expect(receipt).toEqual({
            schema: "supacloud.cli.release-control.v1",
            ok: true,
            operation: "project.create",
            project_ref: CREATE_PROJECT_REF,
            api_url: `https://${CREATE_PROJECT_REF}.api.example.test`,
            credentials_written: false,
        });
        expect(response.content[0].text).not.toContain("ignored-secret");
    });

    test("fails closed if an unrequested response contains one-time credentials", async () => {
        const projectCallback = captureAdminProjectTool({
            post: async () => ({ ok: true, status: 201, data: createResponse() }),
        });

        const response = await projectCallback({
            action: "create",
            name: "unexpected-credential-project",
            api_domain: "api.example.test",
        });

        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).error).toEqual({
            code: "INVALID_RESPONSE",
            http_status: 201,
        });
        expect(response.content[0].text).not.toContain(CREATE_SERVICE_ROLE_KEY);
    });

    test.each([
        {},
        { api_domain: "" },
        { api_domain: "api.example.test/path" },
        { api_domain: "api..example.test" },
        { api_domain: "-api.example.test" },
        { api_domain: "_api.example.test" },
        { api_domain: "api.example.test." },
        { api_domain: "." },
        { domain: "https://example.test" },
    ])("requires a complete API domain before remote credential delivery", async domainArgs => {
        let postCalls = 0;
        const projectCallback = captureAdminProjectTool({
            post: async () => {
                postCalls += 1;
                return { ok: true, status: 201, data: createResponse() };
            },
        });

        const response = await projectCallback({
            action: "create",
            name: "domain-binding-required",
            env_file: join(createSandbox(), "domain-binding.env"),
            environment: "test",
            ...domainArgs,
        });

        expect(postCalls).toBe(0);
        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).error).toEqual({
            code: "API_DOMAIN_BINDING_REQUIRED",
            http_status: null,
        });
    });

    test.each([undefined, "", "staging", "prod", "production "])(
        "requires an exact test or production environment before remote credential delivery",
        async environment => {
            let postCalls = 0;
            const projectCallback = captureAdminProjectTool({
                post: async () => {
                    postCalls += 1;
                    return { ok: true, status: 201, data: createResponse() };
                },
            });

            const response = await projectCallback({
                action: "create",
                name: "environment-binding-required",
                api_domain: "api.example.test",
                env_file: join(createSandbox(), "environment-binding.env"),
                environment,
            });

            expect(postCalls).toBe(0);
            expect(response.isError).toBe(true);
            expect(JSON.parse(response.content[0].text).error).toEqual({
                code: "ENVIRONMENT_BINDING_REQUIRED",
                http_status: null,
            });
        },
    );

    test("preflights the env path before creating a project", async () => {
        const directory = createSandbox();
        const envFile = join(directory, "existing.env");
        writeFileSync(envFile, "keep-me");
        let postCalls = 0;
        const projectCallback = captureAdminProjectTool({
            post: async () => {
                postCalls += 1;
                return { ok: true, status: 201, data: createResponse() };
            },
        });

        const response = await projectCallback({
            action: "create",
            name: "must-not-run",
            api_domain: "api.example.test",
            env_file: envFile,
            environment: "test",
        });

        expect(postCalls).toBe(0);
        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).error).toEqual({
            code: "ENV_FILE_EXISTS",
            http_status: null,
        });
        expect(readFileSync(envFile, "utf8")).toBe("keep-me");
    });

    test.each([
        ["mode 0777 direct parent", "direct parent", 0o777],
        ["mode 1777 direct parent", "direct parent", 0o1777],
        ["mode 0777 ancestor", "ancestor", 0o777],
        ["mode 1777 ancestor", "ancestor", 0o1777],
    ] as const)(
        "rejects a %s before the remote create",
        async (_scenario, unsafeLevel, unsafeMode) => {
            const root = createSandbox();
            const writableDirectory = join(root, "writable");
            const targetParent = unsafeLevel === "direct parent"
                ? writableDirectory
                : join(writableDirectory, "protected");
            mkdirSync(writableDirectory, { mode: 0o700 });
            if (targetParent !== writableDirectory) mkdirSync(targetParent, { mode: 0o700 });
            chmodSync(writableDirectory, unsafeMode);
            const envFile = join(targetParent, "credentials.env");
            let postCalls = 0;
            let reservationCalls = 0;
            const baseFileOperations = testProjectEnvFileOperations();
            const fileOperations: ProjectEnvFileOperations = {
                ...baseFileOperations,
                async openExclusiveAt(directory, filename, mode) {
                    reservationCalls += 1;
                    return baseFileOperations.openExclusiveAt(directory, filename, mode);
                },
            };
            const projectCallback = captureAdminProjectTool({
                post: async () => {
                    postCalls += 1;
                    return { ok: true, status: 201, data: createResponse() };
                },
            }, { projectEnvFileOperations: fileOperations });

            const response = await projectCallback({
                action: "create",
                name: "unsafe-path-project",
                api_domain: "api.example.test",
                env_file: envFile,
                environment: "test",
            });

            expect(postCalls).toBe(0);
            expect(reservationCalls).toBe(0);
            expect(response.isError).toBe(true);
            expect(JSON.parse(response.content[0].text).error.code)
                .toBe("ENV_FILE_PARENT_INVALID");
            expect(existsSync(envFile)).toBe(false);
        },
    );

    test.each(["darwin", "win32"] as const)(
        "fails closed on %s before requesting remote credentials or creating a file",
        async platform => {
            let postCalls = 0;
            const fileOperations = { ...testProjectEnvFileOperations(), platform };
            const projectCallback = captureAdminProjectTool({
                post: async () => {
                    postCalls += 1;
                    return { ok: true, status: 201, data: createResponse() };
                },
            }, { projectEnvFileOperations: fileOperations });
            const directory = createSandbox();
            const envFile = join(directory, `${platform}.env`);

            const response = await projectCallback({
                action: "create",
                name: "unsupported-platform-project",
                api_domain: "api.example.test",
                env_file: envFile,
                environment: "test",
            });

            expect(postCalls).toBe(0);
            expect(JSON.parse(response.content[0].text).error.code)
                .toBe("ENV_FILE_PLATFORM_UNSUPPORTED");
            expect(() => readFileSync(envFile, "utf8")).toThrow();
        },
    );

    test("reserves the env target before the remote credential request", async () => {
        const directory = createSandbox();
        const envFile = join(directory, "raced.env");
        let exclusiveRaceBlocked = false;
        const projectCallback = captureAdminProjectTool({
            post: async () => {
                try {
                    writeFileSync(envFile, "created-during-request", { flag: "wx" });
                } catch (error: unknown) {
                    exclusiveRaceBlocked = (error as { code?: string }).code === "EEXIST";
                }
                return { ok: true, status: 201, data: createResponse({ name: "raced-project" }) };
            },
        });

        const response = await projectCallback({
            action: "create",
            name: "raced-project",
            api_domain: "api.example.test",
            env_file: envFile,
            environment: "test",
        });
        const receipt = JSON.parse(response.content[0].text);

        expect(response.isError).not.toBe(true);
        expect(exclusiveRaceBlocked).toBe(true);
        expect(receipt).toEqual({
            schema: "supacloud.cli.release-control.v1",
            ok: true,
            operation: "project.create",
            project_ref: CREATE_PROJECT_REF,
            api_url: "https://api.example.test",
            credentials_written: true,
            env_file: envFile,
            env_file_scope: "project_application",
        });
        expect(response.content[0].text).not.toContain(CREATE_SERVICE_ROLE_KEY);
        expect(readFileSync(envFile, "utf8")).toContain(CREATE_SERVICE_ROLE_KEY);
    });

    test("reports unknown credential state when secure cleanup cannot be verified", async () => {
        const directory = createSandbox();
        const envFile = join(directory, "cleanup-unknown.env");
        const baseOperations = testProjectEnvFileOperations();
        let credentialsWritten = false;
        const fileOperations: ProjectEnvFileOperations = {
            ...baseOperations,
            async openExclusiveAt(parent, filename, mode) {
                const openFile = await baseOperations.openExclusiveAt(parent, filename, mode);
                return {
                    chmod: requestedMode => openFile.chmod(requestedMode),
                    writeFile: async contents => {
                        await openFile.writeFile(contents);
                        credentialsWritten = true;
                    },
                    sync: () => openFile.sync(),
                    stat: async () => {
                        const stat = await openFile.stat();
                        return {
                            dev: stat.dev,
                            ino: stat.ino,
                            mode: stat.mode,
                            uid: stat.uid,
                            isDirectory: () => false,
                            isFile: () => !credentialsWritten,
                            isSymbolicLink: () => false,
                        };
                    },
                    truncate: async () => { throw new Error("private-truncate-detail"); },
                    close: () => openFile.close(),
                };
            },
            unlinkAt: async () => { throw new Error("private-unlink-detail"); },
        };
        const projectCallback = captureAdminProjectTool({
            post: async () => ({
                ok: true,
                status: 201,
                data: createResponse({ name: "cleanup-unknown-project" }),
            }),
        }, { projectEnvFileOperations: fileOperations });

        const response = await projectCallback({
            action: "create",
            name: "cleanup-unknown-project",
            api_domain: "api.example.test",
            env_file: envFile,
            environment: "production",
        });
        const receipt = JSON.parse(response.content[0].text);

        expect(response.isError).toBe(true);
        expect(receipt).toEqual({
            schema: "supacloud.cli.release-control.v1",
            ok: false,
            operation: "project.create",
            project_ref: CREATE_PROJECT_REF,
            api_url: "https://api.example.test",
            remote_created: true,
            credential_file_state: "unknown",
            retry_safe: false,
            error: { code: "ENV_FILE_CLEANUP_FAILED", http_status: 201 },
        });
        expect(receipt).not.toHaveProperty("credentials_written");
        expect(response.content[0].text).not.toContain(CREATE_SERVICE_ROLE_KEY);
        expect(response.content[0].text).not.toContain("private-");
        expect(readFileSync(envFile, "utf8")).toContain(CREATE_SERVICE_ROLE_KEY);
        expect(readFileSync(envFile, "utf8")).toContain("SUPACLOUD_ENV=production");
    });

    test.each([
        [400, "HTTP_ERROR"],
        [408, "OUTCOME_UNKNOWN"],
        [500, "OUTCOME_UNKNOWN"],
        [503, "OUTCOME_UNKNOWN"],
    ] as const)("classifies HTTP %s without reflecting its response", async (status, code) => {
        const remoteSecret = `remote-http-${status}-secret`;
        const envFile = join(createSandbox(), `${status}.env`);
        const projectCallback = captureAdminProjectTool({
            post: async () => ({
                ok: false,
                status,
                data: { error: remoteSecret, service_role_key: CREATE_SERVICE_ROLE_KEY },
            }),
        });

        const response = await projectCallback({
            action: "create",
            name: "http-failure-project",
            api_domain: "api.example.test",
            env_file: envFile,
            environment: "test",
        });

        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).error).toEqual({ code, http_status: status });
        expect(response.content[0].text).not.toContain(remoteSecret);
        expect(response.content[0].text).not.toContain(CREATE_SERVICE_ROLE_KEY);
        expect(existsSync(envFile)).toBe(false);
    });

    test("classifies a transport failure as outcome unknown with no HTTP status", async () => {
        const envFile = join(createSandbox(), "transport.env");
        const projectCallback = captureAdminProjectTool({
            post: async () => ({
                ok: false,
                status: 500,
                transportError: true,
                data: { error: "private-network-detail" },
            }),
        });

        const response = await projectCallback({
            action: "create",
            name: "transport-failure-project",
            api_domain: "api.example.test",
            env_file: envFile,
            environment: "test",
        });

        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).error).toEqual({
            code: "OUTCOME_UNKNOWN",
            http_status: null,
        });
        expect(response.content[0].text).not.toContain("private-network-detail");
        expect(existsSync(envFile)).toBe(false);
    });

    test("treats an unexpected successful HTTP status as outcome unknown", async () => {
        const envFile = join(createSandbox(), "unexpected-status.env");
        const projectCallback = captureAdminProjectTool({
            post: async () => ({ ok: true, status: 200, data: createResponse() }),
        });

        const response = await projectCallback({
            action: "create",
            name: "unexpected-status-project",
            api_domain: "api.example.test",
            env_file: envFile,
            environment: "test",
        });

        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).error).toEqual({
            code: "OUTCOME_UNKNOWN",
            http_status: 200,
        });
        expect(response.content[0].text).not.toContain(CREATE_SERVICE_ROLE_KEY);
        expect(existsSync(envFile)).toBe(false);
    });

    test("rejects hostile 2xx payloads without reflecting their fields", async () => {
        const remoteSecret = "hostile-success-secret";
        const hostileResponses = [
            { ref: remoteSecret, api: { url: "https://api.example.test" }, credentials: { service_role_key: CREATE_SERVICE_ROLE_KEY } },
            { ref: CREATE_PROJECT_REF, api: { url: `https://${remoteSecret}.example.test` }, credentials: { service_role_key: CREATE_SERVICE_ROLE_KEY } },
            { ref: CREATE_PROJECT_REF, api: { url: "https://api.example.test" }, credentials: { service_role_key: `${CREATE_SERVICE_ROLE_KEY}\n${remoteSecret}` } },
            { ref: CREATE_PROJECT_REF, api: { url: "https://api.example.test" }, credentials: remoteSecret },
        ];
        let responseIndex = 0;
        const directory = createSandbox();
        const projectCallback = captureAdminProjectTool({
            post: async () => ({ ok: true, status: 201, data: hostileResponses[responseIndex++] }),
        });

        for (let index = 0; index < hostileResponses.length; index++) {
            const response = await projectCallback({
                action: "create",
                name: "hostile-project",
                api_domain: "api.example.test",
                env_file: join(directory, `${index}.env`),
                environment: "test",
            });
            expect(response.isError).toBe(true);
            const expectedCode = index < 2 ? "OUTCOME_UNKNOWN" : "INVALID_RESPONSE";
            expect(JSON.parse(response.content[0].text).error.code).toBe(expectedCode);
            expect(response.content[0].text).not.toContain(remoteSecret);
            expect(response.content[0].text).not.toContain(CREATE_SERVICE_ROLE_KEY);
            expect(existsSync(join(directory, `${index}.env`))).toBe(false);
        }
    });
});

describe("admin project runtime snapshot", () => {
    test("declares and requests the bounded runtime snapshot action", async () => {
        const { schema, callback } = captureAdminProjectRegistration({
            get: async (path: string, options: unknown) => {
                expect(path).toBe("/v1/projects/project-ref/runtime-snapshot");
                expect(options).toEqual({ maxJsonBytes: 64 * 1024 });
                return { ok: true, status: 200, data: runtimeSnapshot() };
            },
        });

        const response = await callback({ action: "runtime_snapshot", ref: "project-ref" });

        expect(schemaEnumValues(schema.action)).toContain("runtime_snapshot");
        expect(response.isError).not.toBe(true);
        expect(JSON.parse(response.content[0].text)).toEqual(runtimeSnapshot());
    });

    test("rejects non-objects, extra keys, and wrong snapshot bindings without reflection", async () => {
        const secretMarker = "runtime-snapshot-secret-marker";
        const valid = runtimeSnapshot();
        const invalidPayloads = [
            secretMarker,
            [valid],
            { ...valid, token: secretMarker },
            { ...valid, schema: secretMarker },
            { ...valid, project_ref: secretMarker },
            { ...valid, captured_at: secretMarker },
            { ...valid, secrets: { ...valid.secrets, env_proof: secretMarker } },
            { ...valid, postgrest: { ...valid.postgrest, Authorization: secretMarker } },
        ];

        for (const payload of invalidPayloads) {
            const projectCallback = captureAdminProjectTool({
                get: async () => ({ ok: true, status: 200, data: payload }),
            });
            const response = await projectCallback({ action: "runtime_snapshot", ref: "project-ref" });

            expect(response.isError).toBe(true);
            expect(response.content[0].text).toBe("❌ Project runtime snapshot response is invalid");
            expect(response.content[0].text).not.toContain(secretMarker);
        }
    });

    test("rejects invalid revision, timestamp, port, unit, and state combinations", async () => {
        const valid = runtimeSnapshot();
        const invalidPayloads = [
            { ...valid, secrets: { ...valid.secrets, desired_revision: "sha256:not-attested" } },
            { ...valid, secrets: { ...valid.secrets, loaded_at: "2026-08-11 00:00:00" } },
            { ...valid, secrets: { ...valid.secrets, load_state: "not_loaded" } },
            { ...valid, secrets: { ...valid.secrets, matches_desired: false } },
            { ...valid, postgrest: { ...valid.postgrest, port: 0 } },
            { ...valid, postgrest: { ...valid.postgrest, unit: "supacloud-pgrst@other-ref" } },
            { ...valid, postgrest: { ...valid.postgrest, attestation_state: "stale" } },
            { ...valid, postgrest: { ...valid.postgrest, loaded_at: "not-an-iso-timestamp" } },
        ];

        for (const payload of invalidPayloads) await expectInvalidRuntimeSnapshot(payload);
    });

    test("rejects hostile cross-field projections of stale secrets and loaded PostgREST", async () => {
        const canonicalSnapshot = runtimeSnapshot();
        const staleSecrets = {
            ...canonicalSnapshot.secrets,
            loaded_revision: `hmac-sha256:${"b".repeat(64)}`,
            load_state: "stale",
        };
        const invalidPayloads = [
            { ...canonicalSnapshot, secrets: { ...staleSecrets, matches_desired: true } },
            { ...canonicalSnapshot, secrets: { ...staleSecrets, matches_desired: null } },
            { ...canonicalSnapshot, postgrest: { ...canonicalSnapshot.postgrest, actual: "stopped" } },
            { ...canonicalSnapshot, postgrest: { ...canonicalSnapshot.postgrest, actual: "starting" } },
            { ...canonicalSnapshot, postgrest: { ...canonicalSnapshot.postgrest, actual: "error" } },
            { ...canonicalSnapshot, postgrest: { ...canonicalSnapshot.postgrest, health: "unhealthy" } },
            { ...canonicalSnapshot, postgrest: { ...canonicalSnapshot.postgrest, health: "unknown" } },
            { ...canonicalSnapshot, postgrest: { ...canonicalSnapshot.postgrest, loaded_at: null } },
        ];

        for (const payload of invalidPayloads) await expectInvalidRuntimeSnapshot(payload);
    });

    test("rejects impossible stale PostgREST runtime projections", async () => {
        const valid = runtimeSnapshot();
        const stalePostgrest = {
            ...valid.postgrest,
            loaded_revision: `hmac-sha256:${"b".repeat(64)}`,
            attestation_state: "stale",
            matches_desired: false,
        };
        const invalidPayloads = [
            { ...valid, postgrest: { ...stalePostgrest, actual: "stopped", health: "unknown" } },
            { ...valid, postgrest: { ...stalePostgrest, actual: "starting", health: "unknown" } },
            { ...valid, postgrest: { ...stalePostgrest, health: "unknown" } },
            { ...valid, postgrest: { ...stalePostgrest, health: "unhealthy" } },
            { ...valid, postgrest: { ...stalePostgrest, actual: "error", health: "healthy" } },
            { ...valid, postgrest: { ...stalePostgrest, loaded_revision: null, matches_desired: null } },
            { ...valid, postgrest: { ...stalePostgrest, loaded_at: null } },
        ];

        for (const payload of invalidPayloads) await expectInvalidRuntimeSnapshot(payload);
    });

    test("rejects load timestamps later than the snapshot capture", async () => {
        const valid = runtimeSnapshot();
        const futureLoadedAt = "2026-08-11T00:00:00.001Z";

        await expectInvalidRuntimeSnapshot({
            ...valid,
            secrets: { ...valid.secrets, loaded_at: futureLoadedAt },
        });
        await expectInvalidRuntimeSnapshot({
            ...valid,
            postgrest: { ...valid.postgrest, loaded_at: futureLoadedAt },
        });
    });

    test("accepts canonical stale, unavailable, and unverified states", async () => {
        const valid = runtimeSnapshot();
        const stalePostgrest = {
            ...valid.postgrest,
            loaded_revision: `hmac-sha256:${"b".repeat(64)}`,
            attestation_state: "stale" as const,
            matches_desired: false,
        };
        const acceptedSnapshots = [
            {
                ...valid,
                secrets: {
                    ...valid.secrets,
                    loaded_revision: null,
                    load_state: "unreachable",
                    load_source: null,
                    matches_desired: null,
                    loaded_at: null,
                },
            },
            {
                ...valid,
                secrets: {
                    ...valid.secrets,
                    loaded_revision: `hmac-sha256:${"b".repeat(64)}`,
                    load_state: "stale",
                    matches_desired: false,
                },
            },
            {
                ...valid,
                secrets: {
                    ...valid.secrets,
                    loaded_revision: null,
                    load_state: "unverified",
                    load_source: "file_fallback",
                    matches_desired: null,
                },
            },
            {
                ...valid,
                postgrest: {
                    ...valid.postgrest,
                    loaded_revision: null,
                    attestation_state: "unverified_legacy",
                    matches_desired: null,
                },
            },
            {
                ...valid,
                postgrest: {
                    ...valid.postgrest,
                    loaded_revision: null,
                    attestation_state: "stopped",
                    matches_desired: null,
                    desired: "stopped",
                    actual: "stopped",
                    health: "unknown",
                    loaded_at: null,
                },
            },
            { ...valid, postgrest: stalePostgrest },
            {
                ...valid,
                postgrest: { ...stalePostgrest, actual: "error" as const, health: "unhealthy" as const },
            },
        ];

        for (const snapshot of acceptedSnapshots) {
            const projectCallback = captureAdminProjectTool({
                get: async () => ({ ok: true, status: 200, data: snapshot }),
            });
            const response = await projectCallback({ action: "runtime_snapshot", ref: "project-ref" });
            expect(response.isError).not.toBe(true);
        }
    });

    test("fails closed when the bounded HTTP reader rejects the body", async () => {
        const projectCallback = captureAdminProjectTool({
            get: async () => ({
                ok: false,
                status: 200,
                data: { error: "Invalid Response", code: "INVALID_RESPONSE" },
                responseError: true,
            }),
        });

        const response = await projectCallback({ action: "runtime_snapshot", ref: "project-ref" });

        expect(response.isError).toBe(true);
        expect(response.content[0].text).toBe("❌ Project runtime snapshot response is invalid");
    });
});

describe("admin project services", () => {
    test("declares inventory and constrained service control actions", () => {
        const { schema } = captureAdminProjectRegistration({});

        expect(schemaEnumValues(schema.action)).toContain("services");
        expect(schemaEnumValues(schema.action)).toContain("service_control");
        expect(schemaEnumValues(schema.service)).toEqual([
            "postgrest", "gotrue", "storage", "postgresql", "realtime", "gateway",
        ]);
        expect(schemaEnumValues(schema.service_action)).toEqual([
            "start", "stop", "restart", "pause", "resume", "status",
        ]);
    });

    test("lists a strictly validated project service inventory", async () => {
        let requestedPath = "";
        const projectCallback = captureAdminProjectTool({
            get: async (path: string) => {
                requestedPath = path;
                const inventory = studioServiceInventory("project-ref", "Legacy_Owner");
                return {
                    ok: true,
                    status: 200,
                    data: inventory.map((service) => ({
                        ...service,
                        token: REMOTE_RESPONSE_DETAILS[0],
                        secret: REMOTE_RESPONSE_DETAILS[1],
                        Authorization: REMOTE_RESPONSE_DETAILS[2],
                        project_ref: REMOTE_RESPONSE_DETAILS[3],
                        message: REMOTE_RESPONSE_DETAILS[4],
                    })),
                };
            },
        });

        const response = await projectCallback({ action: "services", ref: "project-ref" });
        const output = JSON.parse(response.content[0].text);

        expect(requestedPath).toBe("/v1/projects/project-ref/services");
        expect(response.isError).not.toBe(true);
        expect(output.project_ref).toBe("project-ref");
        expect(output.services).toEqual(studioServiceInventory("project-ref", "Legacy_Owner"));
        expectNoRemoteResponseDetails(response.content[0].text);
    });

    test("rejects secrets placed in every string-valued inventory field", async () => {
        const secretMarker = "inventory-secret-marker";
        const maliciousFields = [
            { field: "id", value: secretMarker },
            { field: "name", value: secretMarker },
            { field: "status", value: secretMarker },
            { field: "service_host_ids", value: [secretMarker] },
        ] as const;

        for (const maliciousField of maliciousFields) {
            const inventory = studioServiceInventory();
            inventory[0] = { ...inventory[0], [maliciousField.field]: maliciousField.value };
            const projectCallback = captureAdminProjectTool({
                get: async () => ({ ok: true, status: 200, data: inventory }),
            });
            const response = await projectCallback({ action: "services", ref: "project-ref" });

            expect(response.isError).toBe(true);
            expect(response.content[0].text).toBe("❌ Project service inventory response is invalid");
            expect(response.content[0].text).not.toContain(secretMarker);
        }
    });

    test("rejects an oversized inventory without reflecting its allowed fields", async () => {
        const oversizedMarker = "oversized-secret-".repeat(64);
        const oversizedInventory = Array.from({ length: 256 }, () => ({
            id: oversizedMarker,
            name: oversizedMarker,
            status: oversizedMarker,
            healthy: false,
            service_host_ids: [oversizedMarker],
        }));
        const projectCallback = captureAdminProjectTool({
            get: async () => ({ ok: true, status: 200, data: oversizedInventory }),
        });

        const response = await projectCallback({ action: "services", ref: "project-ref" });

        expect(response.isError).toBe(true);
        expect(response.content[0].text).toBe("❌ Project service inventory response is invalid");
        expect(response.content[0].text).not.toContain(oversizedMarker);
        expect(JSON.stringify(oversizedInventory).length).toBeGreaterThan(1_000_000);
    });

    test("rejects duplicate, missing, inconsistent, and unbound service entries", async () => {
        const duplicate = studioServiceInventory();
        duplicate[4] = { ...duplicate[0] };
        const badStatus = studioServiceInventory();
        badStatus[1] = { ...badStatus[1], status: "INACTIVE" };
        const healthyMismatch = studioServiceInventory();
        healthyMismatch[0] = { ...healthyMismatch[0], healthy: false };
        const multipleHostIds = studioServiceInventory();
        multipleHostIds[2] = {
            ...multipleHostIds[2],
            service_host_ids: ["owner-ref-auth", "project-ref-auth"],
        };
        const invalidInventories = [
            duplicate,
            studioServiceInventory().slice(0, 4),
            badStatus,
            healthyMismatch,
            multipleHostIds,
        ];

        for (const inventory of invalidInventories) await expectInvalidInventory(inventory);
    });

    test("rejects unsafe project refs and host bindings", async () => {
        const badNonAuthHost = studioServiceInventory();
        badNonAuthHost[0] = { ...badNonAuthHost[0], service_host_ids: ["other-ref-db"] };
        const unsafeAuthHosts = [
            "unsafe/owner-auth",
            "owner-ref-that-is-too-long-auth",
            "owner\nref-auth",
        ];

        await expectInvalidInventory(badNonAuthHost);
        for (const unsafeHost of unsafeAuthHosts) {
            const badAuthHost = studioServiceInventory();
            badAuthHost[2] = { ...badAuthHost[2], service_host_ids: [unsafeHost] };
            await expectInvalidInventory(badAuthHost);
        }
        await expectInvalidInventory(studioServiceInventory(), "unsafe/project");
        await expectInvalidInventory(studioServiceInventory("Legacy_Owner"), "Legacy_Owner");
    });
});

describe("admin project service control", () => {
    test("stops local GoTrue through the exact Management API route", async () => {
        let requestedPath = "";
        let requestBody: unknown = "not-called";
        const projectCallback = captureAdminProjectTool({
            post: async (path: string, body: unknown) => {
                requestedPath = path;
                requestBody = body;
                return {
                    ok: true,
                    status: 200,
                    data: {
                        service: "gotrue",
                        action: "stop",
                        success: true,
                        message: "Service gotrue stop succeeded",
                        token: REMOTE_RESPONSE_DETAILS[0],
                        secret: REMOTE_RESPONSE_DETAILS[1],
                        Authorization: REMOTE_RESPONSE_DETAILS[2],
                        project_ref: REMOTE_RESPONSE_DETAILS[3],
                        detail: REMOTE_RESPONSE_DETAILS[4],
                    },
                };
            },
        });

        const response = await projectCallback({
            action: "service_control",
            ref: "project-ref",
            service: "gotrue",
            service_action: "stop",
        });
        const receipt = JSON.parse(response.content[0].text);

        expect(requestedPath).toBe("/v1/projects/project-ref/services/gotrue/stop");
        expect(requestBody).toBeUndefined();
        expect(response.isError).not.toBe(true);
        expect(receipt).toEqual({
            project_ref: "project-ref",
            service: "gotrue",
            action: "stop",
            success: true,
        });
        expectNoRemoteResponseDetails(response.content[0].text);
    });

    test("routes every Management API-supported canonical service and action pair", async () => {
        const requestedPaths: string[] = [];
        const projectCallback = captureAdminProjectTool({
            post: async (path: string) => {
                requestedPaths.push(path);
                const [, , , , , service, serviceAction] = path.split("/");
                return {
                    ok: true,
                    status: 200,
                    data: {
                        service,
                        action: serviceAction,
                        success: true,
                        message: `Service ${service} ${serviceAction} succeeded`,
                    },
                };
            },
        });
        const supportedActions = {
            postgrest: ["start", "stop", "restart", "pause", "resume", "status"],
            gotrue: ["start", "stop", "restart"],
            storage: ["start", "stop", "restart"],
            postgresql: ["start", "stop", "restart"],
            realtime: ["start", "stop", "restart"],
            gateway: ["start", "stop", "restart"],
        } as const;

        for (const [service, serviceActions] of Object.entries(supportedActions)) {
            for (const serviceAction of serviceActions) {
                const response = await projectCallback({
                    action: "service_control",
                    ref: "project-ref",
                    service,
                    service_action: serviceAction,
                });
                expect(response.isError).not.toBe(true);
            }
        }

        expect(requestedPaths).toHaveLength(21);
        expect(requestedPaths).toContain("/v1/projects/project-ref/services/postgrest/status");
        expect(requestedPaths).toContain("/v1/projects/project-ref/services/gateway/restart");
    });

    test("rejects unsupported service and action pairs before the request", async () => {
        let requestCount = 0;
        const projectCallback = captureAdminProjectTool({
            post: async () => {
                requestCount += 1;
                return { ok: true, status: 200, data: {} };
            },
        });

        await expect(projectCallback({
            action: "service_control",
            ref: "project-ref",
            service: "storage",
            service_action: "pause",
        })).rejects.toThrow("'pause' is not supported for service 'storage'");
        expect(requestCount).toBe(0);
    });

    test("treats an HTTP 200 failure receipt as an error", async () => {
        const projectCallback = captureAdminProjectTool({
            post: async () => ({
                ok: true,
                status: 200,
                data: {
                    service: "gotrue",
                    action: "stop",
                    success: false,
                    message: REMOTE_RESPONSE_DETAILS[4],
                    token: REMOTE_RESPONSE_DETAILS[0],
                    secret: REMOTE_RESPONSE_DETAILS[1],
                    Authorization: REMOTE_RESPONSE_DETAILS[2],
                    project_ref: REMOTE_RESPONSE_DETAILS[3],
                },
            }),
        });

        const response = await projectCallback({
            action: "service_control",
            ref: "project-ref",
            service: "gotrue",
            service_action: "stop",
        });

        expect(response.isError).toBe(true);
        expect(response.content[0].text).toBe("❌ Project service control failed");
        expectNoRemoteResponseDetails(response.content[0].text);
    });

    test("rejects a success receipt that does not match the request", async () => {
        const projectCallback = captureAdminProjectTool({
            post: async () => ({
                ok: true,
                status: 200,
                data: {
                    service: "storage",
                    action: "stop",
                    success: true,
                    message: REMOTE_RESPONSE_DETAILS[4],
                    token: REMOTE_RESPONSE_DETAILS[0],
                    secret: REMOTE_RESPONSE_DETAILS[1],
                    Authorization: REMOTE_RESPONSE_DETAILS[2],
                    project_ref: REMOTE_RESPONSE_DETAILS[3],
                },
            }),
        });

        const response = await projectCallback({
            action: "service_control",
            ref: "project-ref",
            service: "gotrue",
            service_action: "stop",
        });

        expect(response.isError).toBe(true);
        expect(response.content[0].text).toBe("❌ Project service control response does not match the request");
        expectNoRemoteResponseDetails(response.content[0].text);
    });

    test("rejects malformed success receipts without reflecting response fields", async () => {
        const projectCallback = captureAdminProjectTool({
            post: async () => ({
                ok: true,
                status: 200,
                data: {
                    service: "gotrue",
                    action: "stop",
                    success: true,
                    message: { detail: REMOTE_RESPONSE_DETAILS[4] },
                    token: REMOTE_RESPONSE_DETAILS[0],
                    secret: REMOTE_RESPONSE_DETAILS[1],
                    Authorization: REMOTE_RESPONSE_DETAILS[2],
                    project_ref: REMOTE_RESPONSE_DETAILS[3],
                },
            }),
        });

        const response = await projectCallback({
            action: "service_control",
            ref: "project-ref",
            service: "gotrue",
            service_action: "stop",
        });

        expect(response.isError).toBe(true);
        expect(response.content[0].text).toBe("❌ Project service control response is invalid");
        expectNoRemoteResponseDetails(response.content[0].text);
    });

    test("bounds the unused success receipt message", async () => {
        let receiptMessage = "m".repeat(256);
        const projectCallback = captureAdminProjectTool({
            post: async () => ({
                ok: true,
                status: 200,
                data: {
                    service: "gotrue",
                    action: "stop",
                    success: true,
                    message: receiptMessage,
                },
            }),
        });
        const request = {
            action: "service_control",
            ref: "project-ref",
            service: "gotrue",
            service_action: "stop",
        };

        const boundedResponse = await projectCallback(request);
        expect(boundedResponse.isError).not.toBe(true);
        expect(boundedResponse.content[0].text).not.toContain(receiptMessage);

        receiptMessage = "oversized-message-secret-".repeat(11);
        const oversizedResponse = await projectCallback(request);
        expect(receiptMessage.length).toBeGreaterThan(256);
        expect(oversizedResponse.isError).toBe(true);
        expect(oversizedResponse.content[0].text).toBe("❌ Project service control response is invalid");
        expect(oversizedResponse.content[0].text).not.toContain(receiptMessage);
    });

    test("reports generic HTTP failures using only the local status", async () => {
        const projectCallback = captureAdminProjectTool({
            post: async () => ({
                ok: false,
                status: 502,
                data: {
                    message: REMOTE_RESPONSE_DETAILS[4],
                    token: REMOTE_RESPONSE_DETAILS[0],
                    secret: REMOTE_RESPONSE_DETAILS[1],
                    Authorization: REMOTE_RESPONSE_DETAILS[2],
                    project_ref: REMOTE_RESPONSE_DETAILS[3],
                },
            }),
        });

        const response = await projectCallback({
            action: "service_control",
            ref: "project-ref",
            service: "gotrue",
            service_action: "stop",
        });

        expect(response.isError).toBe(true);
        expect(response.content[0].text).toBe("❌ Failed (502)");
        expectNoRemoteResponseDetails(response.content[0].text);
    });

    test("preserves the shared Auth owner boundary as a non-zero CLI result", async () => {
        const projectCallback = captureAdminProjectTool({
            post: async () => ({
                ok: false,
                status: 409,
                data: {
                    code: "AUTH_RUNTIME_MANAGED_BY_OWNER",
                    authority_project_ref: "Legacy_Owner",
                    message: REMOTE_RESPONSE_DETAILS[4],
                    token: REMOTE_RESPONSE_DETAILS[0],
                    secret: REMOTE_RESPONSE_DETAILS[1],
                    Authorization: REMOTE_RESPONSE_DETAILS[2],
                    project_ref: REMOTE_RESPONSE_DETAILS[3],
                },
            }),
        });

        const response = await projectCallback({
            action: "service_control",
            ref: "shared-project",
            service: "gotrue",
            service_action: "stop",
        });

        expect(response.isError).toBe(true);
        expect(response.content[0].text).toBe(
            '❌ {"status":409,"code":"AUTH_RUNTIME_MANAGED_BY_OWNER","authority_project_ref":"Legacy_Owner"}',
        );
        expectNoRemoteResponseDetails(response.content[0].text);
    });

    test("does not expose malformed owner-boundary response details", async () => {
        const unsafeOwnerResponses = [
            { status: 403, code: "AUTH_RUNTIME_MANAGED_BY_OWNER", authorityRef: "supauth-owner" },
            { status: 409, code: "UNEXPECTED_CODE", authorityRef: "supauth-owner" },
            { status: 409, code: "AUTH_RUNTIME_MANAGED_BY_OWNER", authorityRef: "unsafe/project" },
            { status: 409, code: "AUTH_RUNTIME_MANAGED_BY_OWNER", authorityRef: "owner-ref-that-is-too-long" },
            { status: 409, code: "AUTH_RUNTIME_MANAGED_BY_OWNER", authorityRef: "owner\nref" },
        ];

        for (const ownerResponse of unsafeOwnerResponses) {
            const projectCallback = captureAdminProjectTool({
                post: async () => ({
                    ok: false,
                    status: ownerResponse.status,
                    data: {
                        code: ownerResponse.code,
                        authority_project_ref: ownerResponse.authorityRef,
                        message: REMOTE_RESPONSE_DETAILS[4],
                        token: REMOTE_RESPONSE_DETAILS[0],
                        secret: REMOTE_RESPONSE_DETAILS[1],
                        Authorization: REMOTE_RESPONSE_DETAILS[2],
                        project_ref: REMOTE_RESPONSE_DETAILS[3],
                    },
                }),
            });

            const response = await projectCallback({
                action: "service_control",
                ref: "shared-project",
                service: "gotrue",
                service_action: "stop",
            });

            expect(response.isError).toBe(true);
            expect(response.content[0].text).toBe(`❌ Failed (${ownerResponse.status})`);
            expectNoRemoteResponseDetails(response.content[0].text);
        }
    });
});
