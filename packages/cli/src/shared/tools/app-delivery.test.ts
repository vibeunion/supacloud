import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAppTools, runAppTool, type AppToolArguments } from "./app-tools";
import { registerApplicationTools } from "./application-tools";
import type { HttpTransport } from "../transports/http";
import type { ToolSchema } from "../schema";
import { parseToolArguments } from "../schema";
import { executionMode, validateExecutionPolicyCoverage } from "../execution-policy";
import type { ReleaseControlToolResponse } from "./release-control-response";

const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));
const entry = join(packageRoot, "src/index.ts");
const identity = {
    ref: "project", id: "orders", environment_id: "test",
    release_id: "a".repeat(64),
    configuration_id: "11234567-89ab-4def-8123-456789abcdef",
    activation_id: "21234567-89ab-4def-8123-456789abcdef",
    expected_activation_id: "31234567-89ab-4def-8123-456789abcdef",
};

function schema(): ToolSchema {
    let captured: ToolSchema = {};
    registerAppTools({ tool(_name, _description, value) { captured = value; } });
    return captured;
}

async function fixture() {
    const root = await mkdtemp(join(packageRoot, ".app-delivery-test-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { experimentalDecorators: true, target: "ES2022", module: "ESNext", moduleResolution: "bundler" },
    }));
    await writeFile(join(root, "src/orders.ts"), `
function Module(_options: unknown): ClassDecorator { return () => {}; }
function Controller(_path: string): ClassDecorator { return () => {}; }
function Get(_path: string): MethodDecorator { return () => {}; }
@Controller("/orders")
export class OrdersController {
    @Get("/")
    list(): string { return "orders"; }
}
@Module({ name: "orders", providers: [], controllers: [OrdersController] })
export class OrdersModule {}
`);
    await writeFile(join(root, "supacloud.config.ts"), `export default {
        root: "src", outDir: "artifacts", strict: false,
        delivery: { version: 1, targets: [{ name: "api", kind: "api", modules: ["orders"] }] }
    };`);
    return root;
}

async function snapshot(root: string): Promise<Record<string, string>> {
    const files = await readdir(root, { recursive: true, withFileTypes: true });
    return Object.fromEntries(await Promise.all(files.filter(file => file.isFile()).map(async file => {
        const path = join(file.parentPath, file.name);
        return [path, await readFile(path, "utf8")];
    })));
}

test("merged app schema preserves credential-free local arguments and classifies every action", () => {
    const value = schema();
    validateExecutionPolicyCoverage({ app: { schema: value } });
    for (const action of ["plan", "build", "check", "compile"]) {
        expect(parseToolArguments(value, { action, root: "." })).toEqual({ action, root: "." });
        expect(executionMode("app", action, {})).toBe("local");
    }
    expect(executionMode("app", "status", {})).toBe("read");
    for (const action of ["upload", "configure", "deploy", "rollback", "reconcile", "retire"]) {
        expect(executionMode("app", action, { dry_run: true })).toBe("write");
    }
    expect(() => parseToolArguments(value, { action: "rollback", ...identity, release_id: "latest" })).toThrow();
});

test("plan uses configured delivery topology, writes nothing and promises no release digest", async () => {
    const root = await fixture();
    try {
        const before = await snapshot(root);
        const result = await runAppTool({ action: "plan", root, format: "json" });
        const body = JSON.parse(result.content[0]!.text);
        expect(result.isError).toBe(false);
        expect(body.plan.targets[0].name).toBe("api");
        expect(body.written).toEqual([]);
        expect(body.release_id).toBeUndefined();
        expect(body.manifest).toBeUndefined();
        expect(await snapshot(root)).toEqual(before);
        const text = await runAppTool({ action: "plan", root });
        expect(text.content[0]!.text).toContain("topology digest is not a build hash");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("build reuses compiler manifest output without delegating deployment", async () => {
    const root = await fixture();
    try {
        let calls = 0;
        const result = await runAppTool({ action: "build", root }, {
            getApplications: () => async () => { calls++; throw new Error("Unexpected deployment"); },
        });
        const body = JSON.parse(result.content[0]!.text);
        expect(result.isError, JSON.stringify(body.diagnostics)).toBe(false);
        expect(body.manifest).not.toBeNull();
        expect(body.written.length).toBeGreaterThan(0);
        expect(calls).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("remote app actions delegate once and return the identical receipt without fabrication", async () => {
    const aliases = {
        upload: "upload_release", configure: "put_configuration", deploy: "activate_release",
        status: "get_runtime", rollback: "activate_release", reconcile: "reconcile_activation", retire: "retire_activation",
    } as const;
    for (const [alias, action] of Object.entries(aliases)) {
        let calls = 0;
        const receipt = { isError: true, content: [{ type: "text" as const, text: '{"ok":false,"error":{"code":"OUTCOME_UNKNOWN"}}' }] };
        const result = await runAppTool({ ...identity, action: alias as AppToolArguments["action"] }, {
            getApplications: () => async args => {
                calls++;
                expect(args).toEqual({ ...identity, action });
                return receipt;
            },
        });
        expect(calls).toBe(1);
        expect(result).toBe(receipt);
    }
});

test("rollback uses activation endpoint only and keeps malformed responses unknown", async () => {
    for (const data of [{}, {
        project_ref: identity.ref, application_id: identity.id, environment_id: identity.environment_id,
        release_id: identity.release_id, activation_id: identity.activation_id, replayed: false,
    }]) {
        let calls = 0;
        let delegate: ((args: Record<string, unknown>) => Promise<ReleaseControlToolResponse>) | undefined;
        registerApplicationTools({ tool(_name, _description, _schema, handler) { delegate = handler; } }, {
            post: async (path: string, body: unknown) => {
                calls++;
                expect(path).toBe("/v1/projects/project/applications/orders/environments/test/activations");
                expect(body).toEqual({
                    activation_id: identity.activation_id, release_id: identity.release_id,
                    configuration_id: identity.configuration_id, expected_activation_id: identity.expected_activation_id,
                });
                return { ok: true, status: 200, data };
            },
        } as HttpTransport);
        const result = await runAppTool({ action: "rollback", ...identity }, { getApplications: () => delegate });
        const receipt = JSON.parse(result.content[0]!.text);
        expect(calls).toBe(1);
        expect(receipt.operation).toBe("applications.activate_release");
        expect(receipt.release_id).toBe(identity.release_id);
        expect(receipt.rolled_back).toBeUndefined();
        if ("activation_id" in data) expect(receipt.ok).toBe(true);
        else expect(receipt.error.code).toBe("OUTCOME_UNKNOWN");
        for (const change of [{ release_id: undefined }, { configuration_id: undefined }, { expected_activation_id: undefined }]) {
            await expect(runAppTool({ action: "rollback", ...identity, ...change }, { getApplications: () => delegate })).rejects.toThrow();
        }
        expect(calls).toBe(1);
    }
});

async function cli(root: string, args: string[], variables: Record<string, string> = {}) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !/^(SUPACLOUD_|SUPABASE_|MANAGEMENT_API_|X_PROJECT_REF)/.test(key)));
    const child = Bun.spawn([process.execPath, entry, ...args], {
        cwd: root, env: { ...env, ...variables }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { code, output: stdout + stderr };
}

test("action help documents workflow aliases without requiring credentials", async () => {
    const root = await fixture();
    try {
        for (const action of ["deploy", "rollback"]) {
            const result = await cli(root, ["app", action, "--help"]);
            expect(result.code, result.output).toBe(0);
            for (const flag of ["ref", "id", "environment_id", "release_id", "configuration_id", "activation_id", "expected_activation_id"]) {
                expect(result.output).toContain(`--${flag} `);
            }
        }
        const upload = await cli(root, ["app", "upload", "--help"]);
        expect(upload.output).toContain("--manifest_path ");
        expect(upload.output).not.toContain("--expected_activation_id ");
        const plan = await cli(root, ["app", "plan", "--help"]);
        expect(plan.output).toContain("--root ");
        expect(plan.output).toContain("--format ");
    } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("CLI local plan needs no credentials while remote commands preserve credential and write guards", async () => {
    const root = await fixture();
    let requests = 0;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
        requests++;
        return Response.json({});
    } });
    try {
        const local = await cli(root, ["app", "plan", "--format", "json"]);
        expect(local.code, local.output).toBe(0);
        const remoteArgs = ["app", "rollback", ...Object.entries(identity).flatMap(([key, value]) => [`--${key}`, value])];
        const missing = await cli(root, remoteArgs);
        expect(missing.code).toBe(1);
        expect(missing.output).toContain("Management API");
        const base = { SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`, SUPACLOUD_API_TOKEN: "test-token", SUPACLOUD_PROJECT_REF: "project" };
        const readOnly = await cli(root, remoteArgs, { ...base, SUPACLOUD_READ_ONLY: "true" });
        expect(readOnly.code).toBe(1);
        expect(readOnly.output).toContain("read-only");
        const production = await cli(root, remoteArgs, { ...base, SUPACLOUD_ENV: "production" });
        expect(production.code).toBe(1);
        expect(production.output).toContain("--confirm-production project");
        expect(requests).toBe(0);
    } finally {
        server.stop(true);
        await rm(root, { recursive: true, force: true });
    }
}, 30_000);

test("CLI remote wiring uses the context ref and never retries or relabels an unknown activation", async () => {
    const root = await fixture();
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
        requests.push({
            method: request.method, path: new URL(request.url).pathname,
            body: request.method === "POST" ? await request.json() : null,
        });
        if (request.method === "GET") return Response.json({
            project_ref: identity.ref, application_id: identity.id,
            environment_id: identity.environment_id, readiness: null,
        });
        return Response.json({ error: "fixture unknown outcome" }, { status: 500 });
    } });
    const env = {
        SUPACLOUD_API_URL: `http://127.0.0.1:${server.port}`,
        SUPACLOUD_API_TOKEN: "test-token", SUPACLOUD_PROJECT_REF: identity.ref,
    };
    try {
        const status = await cli(root, ["app", "status", "--id", identity.id, "--environment_id", "test"], env);
        expect(status.code, status.output).toBe(0);
        expect(JSON.parse(status.output)).toMatchObject({
            operation: "applications.get_runtime", project_ref: identity.ref, readiness: null,
        });
        const args = Object.entries(identity).filter(([key]) => key !== "ref")
            .flatMap(([key, value]) => [`--${key}`, value]);
        const rollback = await cli(root, ["app", "rollback", ...args], env);
        expect(rollback.code).toBe(1);
        expect(rollback.output).toContain("OUTCOME_UNKNOWN");
        expect(rollback.output).toContain("applications.activate_release");
        expect(rollback.output).not.toContain('"rolled_back"');
        expect(requests).toEqual([
            { method: "GET", path: "/v1/projects/project/applications/orders/environments/test/runtime", body: null },
            {
                method: "POST", path: "/v1/projects/project/applications/orders/environments/test/activations",
                body: {
                    release_id: identity.release_id, configuration_id: identity.configuration_id,
                    activation_id: identity.activation_id, expected_activation_id: identity.expected_activation_id,
                },
            },
        ]);
    } finally {
        server.stop(true);
        await rm(root, { recursive: true, force: true });
    }
}, 30_000);
