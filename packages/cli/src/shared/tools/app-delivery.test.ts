import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAppTools, runAppTool, type AppToolArguments } from "./app-tools";
import { registerApplicationTools } from "./application-tools";
import { HttpTransport } from "../transports/http";
import { Value } from "typebox/value";
import { ApplicationActivationIdSchema, ApplicationActivationWriteSchema } from "./application-schemas";
import type { ToolInvocation } from "../tool-server";
import type { ToolSchema } from "../schema";
import { parseToolArguments } from "../schema";
import { executionMode, validateExecutionPolicyCoverage } from "../execution-policy";
import type { ReleaseControlToolResponse } from "./release-control-response";
import type { ApplicationDeployPlan } from "@supacloud/delivery";

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
    await Bun.write(join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { experimentalDecorators: true, target: "ES2022", module: "ESNext", moduleResolution: "bundler" },
    }));
    await Bun.write(join(root, "src/orders.ts"), `
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
    await Bun.write(join(root, "supacloud.config.ts"), `export default {
        root: "src", outDir: "artifacts", strict: false,
        effect: { requireRouteEffects: false, requireErrorMappings: false, requireDependencies: false },
        delivery: { version: 1, targets: [{ name: "api", kind: "api", modules: ["orders"] }] }
    };`);
    return root;
}

async function snapshot(root: string): Promise<Record<string, string>> {
    const files = await readdir(root, { recursive: true, withFileTypes: true });
    return Object.fromEntries(await Promise.all(files.filter(file => file.isFile()).map(async file => {
        const path = join(file.parentPath, file.name);
        return [path, await Bun.file(path).text()];
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
    expect(executionMode("app", "rollback-plan", {})).toBe("read");
    expect(executionMode("app", "deploy-plan", {})).toBe("read");
    expect(executionMode("app", "diff", {})).toBe("read");
    expect(executionMode("applications", "get_deploy_plan", {})).toBe("read");
    expect(executionMode("applications", "deploy_release", {})).toBe("write");
    expect(executionMode("applications", "get_rollback_snapshot", {})).toBe("read");
    expect(executionMode("applications", "rollback_release", {})).toBe("write");
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

test("build blocks configured database projects before writing when their checker is unavailable", async () => {
    const root = await fixture();
    try {
        await Bun.write(join(root, "database.sources.json"), '{"version":1}');
        const before = await snapshot(root);
        const result = await runAppTool({ action: "build", root });
        const body = JSON.parse(result.content[0]!.text);
        expect(result.isError).toBe(true);
        expect(body.ok).toBe(false);
        expect(body.database.name).toBe("database-source-contracts");
        expect(body.written).toEqual([]);
        expect(await snapshot(root)).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("check and doctor surface database gate failures without regenerating contracts", async () => {
    const root = await fixture();
    try {
        await Bun.write(join(root, "database.sources.json"), '{"version":1}');
        const before = await snapshot(root);
        for (const action of ["check", "doctor"] as const) {
            const result = await runAppTool({ action, root, format: "json" });
            expect(result.isError).toBe(true);
            expect(result.content[0]!.text).toContain("database-source-contracts");
        }
        expect(await snapshot(root)).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("remote app actions delegate once and return the identical receipt without fabrication", async () => {
    const aliases = {
        upload: "upload_release", configure: "put_configuration", deploy: "deploy_release",
        "deploy-plan": "get_deploy_plan", diff: "get_deploy_plan",
        status: "get_runtime", rollback: "rollback_release", "rollback-plan": "get_rollback_snapshot",
        reconcile: "reconcile_activation", retire: "retire_activation",
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
        expect(receipt.operation).toBe("applications.rollback_release");
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
        expect(rollback.output).toContain("applications.rollback_release");
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

function rollbackSnapshot(overrides: Record<string, unknown> = {}) {
    return {
        schema: "supacloud.application-rollback-snapshot.v1",
        project_ref: identity.ref, application_id: identity.id, environment_id: identity.environment_id,
        active: {
            activation_id: identity.expected_activation_id, release_id: "b".repeat(64),
            configuration_id: "41234567-89ab-4def-8123-456789abcdef",
        },
        previous: {
            activation_id: "51234567-89ab-4def-8123-456789abcdef",
            release_id: identity.release_id, configuration_id: identity.configuration_id,
        },
        ...overrides,
    };
}

function deployPlan(mode: "changed" | "unchanged" | "first" = "changed"): ApplicationDeployPlan {
    const current = mode === "first" ? null : {
        activation_id: identity.expected_activation_id,
        release_id: mode === "unchanged" ? identity.release_id : "b".repeat(64),
        configuration_id: identity.configuration_id,
    };
    return {
        schema: "supacloud.application-deploy-plan.v1",
        project_ref: identity.ref, application_id: identity.id, environment_id: identity.environment_id,
        candidate: { release_id: identity.release_id, configuration_id: identity.configuration_id },
        current, expected_activation_id: current?.activation_id ?? null,
        action: mode === "unchanged" ? "no-op" : "activate",
        changes: {
            release: mode !== "unchanged", configuration: mode === "first",
            targets: { added: mode === "first" ? ["api"] : [], removed: [], changed: mode === "changed" ? ["api"] : [] },
        },
        migrations: { ledger_digest: "f".repeat(64), ledger_compatible: true,
            project_migrations_applied: true, operator_provisioning: "not-declared" },
        compatibility: "not-proven", execution_performed: false,
    };
}

function deployHttp(plan: unknown, fault?: "get-unavailable" | "not-found" | "malformed" | "foreign" | "unavailable" | "cas") {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            const url = new URL(request.url);
            const body: unknown = request.method === "POST" ? await request.json() : null;
            calls.push({ method: request.method, path: url.pathname, body });
            if (request.method === "GET") {
                expect(url.pathname).toBe("/v1/projects/project/applications/orders/environments/test/deploy-plan");
                expect(url.searchParams.get("release_id")).toBe(identity.release_id);
                expect(url.searchParams.get("configuration_id")).toBe(identity.configuration_id);
                if (fault === "get-unavailable") return Response.json({ private: "must-not-escape" }, { status: 503 });
                return Response.json(plan, { status: fault === "not-found" ? 404 : 200 });
            }
            expect(url.pathname).toBe("/v1/projects/project/applications/orders/environments/test/activations");
            if (!Value.Check(ApplicationActivationWriteSchema, body)) return new Response("Invalid", { status: 400 });
            if (fault === "malformed") return new Response("Invalid", { status: 200 });
            if (fault === "unavailable") return Response.json({ private: "must-not-escape" }, { status: 503 });
            if (fault === "cas") return Response.json({ code: "APPLICATION_ACTIVATION_CONFLICT" }, { status: 409 });
            return Response.json({
                project_ref: identity.ref, application_id: identity.id, environment_id: identity.environment_id,
                release_id: body.release_id,
                activation_id: fault === "foreign" ? crypto.randomUUID() : body.activation_id,
                replayed: false,
            });
        },
    });
    let delegate: ToolInvocation | undefined;
    registerApplicationTools({
        tool(_name, _description, value, callback) {
            validateExecutionPolicyCoverage({ applications: { schema: value } }); delegate = callback;
        },
    }, new HttpTransport({ baseUrl: server.url.toString(), token: "local-deploy-fixture" }));
    if (!delegate) throw new Error("Missing applications delegate");
    return { server, calls, delegate };
}

const autoDeploy = {
    action: "deploy" as const, id: identity.id, environment_id: identity.environment_id,
    release_id: identity.release_id, configuration_id: identity.configuration_id,
};

test.each(["deploy-plan", "diff"] as const)("%s binds the remote candidate and only performs GET", async action => {
    const plan = deployPlan();
    const f = deployHttp(plan);
    try {
        const options = { projectRef: identity.ref, getApplications: () => f.delegate };
        const json = await runAppTool({ ...autoDeploy, action, format: "json" }, options);
        expect(JSON.parse(json.content[0]!.text)).toMatchObject({ ok: true, operation: "applications.get_deploy_plan", plan });
        const text = await runAppTool({ ...autoDeploy, action }, options);
        expect(text.content[0]!.text).toContain("Activation required");
        expect(text.content[0]!.text).toContain("Targets: ~api");
        expect(text.content[0]!.text).toContain(`Expected activation: ${identity.expected_activation_id}`);
        expect(f.calls.map(call => call.method)).toEqual(["GET", "GET"]);
    } finally { f.server.stop(true); }
});

test("automatic deployment skips verified no-op without inventing a new activation", async () => {
    const f = deployHttp(deployPlan("unchanged"));
    try {
        const result = await runAppTool(autoDeploy, { projectRef: identity.ref, getApplications: () => f.delegate });
        expect(JSON.parse(result.content[0]!.text)).toMatchObject({
            ok: true, operation: "applications.deploy_release", no_op: true, execution_performed: false,
            activation_id: identity.expected_activation_id, release_id: identity.release_id,
        });
        expect(f.calls.map(call => call.method)).toEqual(["GET"]);
        expect(result.content[0]!.text).not.toContain('"replayed"');
    } finally { f.server.stop(true); }
});

test.each(["changed", "first"] as const)("automatic %s deployment submits exactly once with observed CAS", async mode => {
    const plan = deployPlan(mode), f = deployHttp(plan);
    try {
        const result = await runAppTool(autoDeploy, { projectRef: identity.ref, getApplications: () => f.delegate });
        const output: Record<string, unknown> = JSON.parse(result.content[0]!.text);
        expect(output).toMatchObject({ ok: true, operation: "applications.deploy_release",
            release_id: identity.release_id, configuration_id: identity.configuration_id,
            expected_activation_id: plan.expected_activation_id,
        });
        expect(Value.Check(ApplicationActivationIdSchema, output.activation_id)).toBe(true);
        expect(output.activation_id).not.toBe(plan.expected_activation_id);
        expect(f.calls.map(call => call.method)).toEqual(["GET", "POST"]);
        expect(f.calls[1]!.body).toEqual({ release_id: identity.release_id, configuration_id: identity.configuration_id,
            activation_id: output.activation_id, expected_activation_id: plan.expected_activation_id });
    } finally { f.server.stop(true); }
});

test.each([
    ["foreign project", { ...deployPlan("unchanged"), project_ref: "foreign" }],
    ["foreign application", { ...deployPlan("unchanged"), application_id: "foreign" }],
    ["foreign environment", { ...deployPlan("unchanged"), environment_id: "production" }],
    ["foreign candidate", { ...deployPlan("unchanged"), candidate: { ...deployPlan().candidate, release_id: "b".repeat(64) } }],
    ["foreign configuration", { ...deployPlan("unchanged"), candidate: { ...deployPlan().candidate, configuration_id: crypto.randomUUID() } }],
    ["unbound CAS", { ...deployPlan("unchanged"), expected_activation_id: null }],
    ["incomplete", {}],
    ["forged no-op", { ...deployPlan(), action: "no-op" }],
    ["pending no-op", { ...deployPlan("unchanged"), migrations: { ...deployPlan().migrations, project_migrations_applied: false } }],
    ["private fields", { ...deployPlan("unchanged"), private: "must-not-escape" }],
] satisfies Array<[string, unknown]>)("automatic deploy refuses %s before POST", async (_name, plan) => {
    const f = deployHttp(plan);
    try {
        const result = await runAppTool(autoDeploy, { projectRef: identity.ref, getApplications: () => f.delegate });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]!.text)).toMatchObject({ error: { code: "INVALID_RESPONSE" } });
        expect(f.calls.map(call => call.method)).toEqual(["GET"]);
        expect(result.content[0]!.text).not.toContain("must-not-escape");
    } finally { f.server.stop(true); }
});

test.each(["get-unavailable", "not-found"] as const)("no automatic activation fallback on %s plan", async fault => {
    const f = deployHttp({}, fault);
    try {
        const result = await runAppTool(autoDeploy, { projectRef: identity.ref, getApplications: () => f.delegate });
        expect(result.isError).toBe(true);
        expect(f.calls.every(call => call.method === "GET")).toBe(true);
        expect(result.content[0]!.text).not.toContain("must-not-escape");
    } finally { f.server.stop(true); }
});

test.each(["malformed", "foreign", "unavailable", "cas"] as const)("automatic deployment preserves %s outcome and never retries POST", async fault => {
    const f = deployHttp(deployPlan(), fault);
    try {
        const result = await runAppTool(autoDeploy, { projectRef: identity.ref, getApplications: () => f.delegate });
        const output: Record<string, unknown> = JSON.parse(result.content[0]!.text);
        expect(result.isError).toBe(true);
        expect(output).toMatchObject({
            operation: "applications.deploy_release", error: { code: fault === "cas" ? "HTTP_ERROR" : "OUTCOME_UNKNOWN" },
            release_id: identity.release_id, configuration_id: identity.configuration_id,
            expected_activation_id: identity.expected_activation_id,
        });
        expect(Value.Check(ApplicationActivationIdSchema, output.activation_id)).toBe(true);
        expect(f.calls.map(call => call.method)).toEqual(["GET", "POST"]);
        expect(result.content[0]!.text).not.toContain("must-not-escape");
    } finally { f.server.stop(true); }
});

test("explicit deployment retry retains exact UUID/CAS without planning or skipping", async () => {
    const f = deployHttp(deployPlan("unchanged"));
    try {
        const result = await runAppTool({ ...autoDeploy, activation_id: identity.activation_id,
            expected_activation_id: identity.expected_activation_id },
        { projectRef: identity.ref, getApplications: () => f.delegate });
        expect(f.calls.map(call => call.method)).toEqual(["POST"]);
        expect(f.calls[0]!.body).toEqual({
            release_id: identity.release_id, configuration_id: identity.configuration_id,
            activation_id: identity.activation_id, expected_activation_id: identity.expected_activation_id,
        });
        expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: true, activation_id: identity.activation_id });
    } finally { f.server.stop(true); }
});

test("explicit CAS conflict fails before activation even when the plan is unchanged", async () => {
    const f = deployHttp(deployPlan("unchanged"));
    try {
        const result = await runAppTool({ ...autoDeploy, expected_activation_id: "absent" },
            { projectRef: identity.ref, getApplications: () => f.delegate });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]!.text)).toMatchObject({ reason: "EXPECTED_ACTIVATION_CONFLICT" });
        expect(f.calls.map(call => call.method)).toEqual(["GET"]);
    } finally { f.server.stop(true); }
});

test("invalid candidate or activation flags perform no HTTP", async () => {
    const f = deployHttp(deployPlan());
    try {
        for (const flags of [{ configuration_id: undefined }, { release_id: undefined },
            { environment_id: undefined }, { activation_id: "invalid" }, { expected_activation_id: "latest" }]) {
            await expect(runAppTool({ ...autoDeploy, ...flags }, {
                projectRef: identity.ref, getApplications: () => f.delegate,
            })).rejects.toThrow();
        }
        expect(f.calls).toEqual([]);
    } finally { f.server.stop(true); }
});

test("CLI deployment plan help and read-only/production guards remain effective", async () => {
    const root = await fixture(), f = deployHttp(deployPlan("unchanged"));
    const variables = {
        SUPACLOUD_API_URL: f.server.url.toString(), SUPACLOUD_API_TOKEN: "local-deploy-fixture",
        SUPACLOUD_PROJECT_REF: identity.ref, SUPACLOUD_ENV: "production",
    };
    const flags = Object.entries(autoDeploy).filter(([key]) => key !== "action").flatMap(([key, value]) => [`--${key}`, value]);
    try {
        const help = await cli(root, ["app", "deploy-plan", "--help"]);
        expect(help.code, help.output).toBe(0);
        for (const flag of ["ref", "id", "environment_id", "release_id", "configuration_id", "format"]) {
            expect(help.output).toContain(`--${flag} `);
        }
        expect(help.output).not.toContain("--activation_id ");
        const readOnly = await cli(root, ["app", "deploy", ...flags], { ...variables, SUPACLOUD_READ_ONLY: "true" });
        expect(readOnly.code).toBe(1);
        const unconfirmed = await cli(root, ["app", "deploy", ...flags], variables);
        expect(unconfirmed.code).toBe(1);
        expect(f.calls).toEqual([]);
        const plan = await cli(root, ["app", "diff", ...flags, "--format", "json"], { ...variables, SUPACLOUD_READ_ONLY: "true" });
        expect(plan.code, plan.output).toBe(0);
        expect(JSON.parse(plan.output)).toMatchObject({ operation: "applications.get_deploy_plan", plan: { action: "no-op" } });
        expect(f.calls.map(call => call.method)).toEqual(["GET"]);
    } finally { f.server.stop(true); await rm(root, { recursive: true, force: true }); }
}, 30_000);

function rollbackHttp(snapshot: unknown, fault?: "malformed" | "foreign" | "unavailable" | "not-found") {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
            const path = new URL(request.url).pathname;
            const body: unknown = request.method === "POST" ? await request.json() : null;
            calls.push({ method: request.method, path, body });
            if (request.method === "GET") {
                expect(path).toBe("/v1/projects/project/applications/orders/environments/test/rollback-snapshot");
                return Response.json(snapshot, { status: fault === "not-found" ? 404 : 200 });
            }
            expect(path).toBe("/v1/projects/project/applications/orders/environments/test/activations");
            expect(Value.Check(ApplicationActivationWriteSchema, body)).toBe(true);
            if (!Value.Check(ApplicationActivationWriteSchema, body)) return new Response("invalid", { status: 400 });
            if (fault === "malformed") return new Response("invalid", { status: 200 });
            if (fault === "unavailable") return Response.json({ password: "must-not-escape" }, { status: 503 });
            return Response.json({
                project_ref: identity.ref, application_id: identity.id, environment_id: identity.environment_id,
                release_id: body.release_id,
                activation_id: fault === "foreign" ? crypto.randomUUID() : body.activation_id,
                replayed: false,
            });
        },
    });
    let delegate: ToolInvocation | undefined;
    registerApplicationTools({
        tool(_name, _description, value, callback) {
            validateExecutionPolicyCoverage({ applications: { schema: value } });
            delegate = callback;
        },
    }, new HttpTransport({ baseUrl: server.url.toString(), token: "local-rollback-fixture" }));
    if (!delegate) throw new Error("Missing applications delegate");
    return { server, calls, delegate };
}

const defaultRollback = { action: "rollback" as const, id: identity.id, environment_id: identity.environment_id };

test("default rollback selects platform previous and generates one activation identity", async () => {
    const f = rollbackHttp(rollbackSnapshot());
    try {
        const result = await runAppTool(defaultRollback, { projectRef: identity.ref, getApplications: () => f.delegate });
        const output: Record<string, unknown> = JSON.parse(result.content[0]!.text);
        expect(result.isError).toBeUndefined();
        expect(output).toMatchObject({
            ok: true, operation: "applications.rollback_release", release_id: identity.release_id,
            configuration_id: identity.configuration_id, expected_activation_id: identity.expected_activation_id,
        });
        expect(Value.Check(ApplicationActivationIdSchema, output.activation_id)).toBe(true);
        expect(output.activation_id).not.toBe(identity.expected_activation_id);
        expect(f.calls.map(call => call.method)).toEqual(["GET", "POST"]);
        expect(f.calls[1]!.body).toEqual({
            activation_id: output.activation_id, release_id: identity.release_id,
            configuration_id: identity.configuration_id, expected_activation_id: identity.expected_activation_id,
        });
    } finally { await f.server.stop(true); }
});

test("rollback-plan returns the verified snapshot without activating", async () => {
    const snapshot = rollbackSnapshot();
    const f = rollbackHttp(snapshot);
    try {
        const result = await runAppTool({ ...defaultRollback, action: "rollback-plan" },
            { projectRef: identity.ref, getApplications: () => f.delegate });
        expect(JSON.parse(result.content[0]!.text)).toMatchObject({
            ok: true, operation: "applications.get_rollback_snapshot", snapshot,
        });
        expect(f.calls.map(call => call.method)).toEqual(["GET"]);
    } finally { await f.server.stop(true); }
});

test.each([
    ["foreign project", rollbackSnapshot({ project_ref: "other" })],
    ["foreign application", rollbackSnapshot({ application_id: "other" })],
    ["foreign environment", rollbackSnapshot({ environment_id: "production" })],
    ["incomplete response", {}],
    ["missing previous", rollbackSnapshot({ previous: null })],
    ["missing active", rollbackSnapshot({ active: null })],
    ["same activation", rollbackSnapshot({ previous: { ...rollbackSnapshot().previous, activation_id: identity.expected_activation_id } })],
    ["invalid previous release", rollbackSnapshot({ previous: { ...rollbackSnapshot().previous, release_id: "latest" } })],
    ["extra secret fields", rollbackSnapshot({ password: "must-not-escape" })],
] satisfies Array<[string, unknown]>)("default rollback refuses %s without guessing or POST", async (_name, snapshot) => {
    const f = rollbackHttp(snapshot);
    try {
        const result = await runAppTool(defaultRollback, { projectRef: identity.ref, getApplications: () => f.delegate });
        expect(result.isError).toBe(true);
        expect(f.calls.map(call => call.method)).toEqual(["GET"]);
        expect(result.content[0]!.text).not.toContain("must-not-escape");
    } finally { await f.server.stop(true); }
});

test.each(["malformed", "foreign", "unavailable"] as const)("default rollback %s receipt retains exact identities without replay", async fault => {
    const f = rollbackHttp(rollbackSnapshot(), fault);
    try {
        const result = await runAppTool(defaultRollback, { projectRef: identity.ref, getApplications: () => f.delegate });
        const output: Record<string, unknown> = JSON.parse(result.content[0]!.text);
        expect(result.isError).toBe(true);
        expect(output).toMatchObject({
            operation: "applications.rollback_release", error: { code: "OUTCOME_UNKNOWN" },
            release_id: identity.release_id, configuration_id: identity.configuration_id,
            expected_activation_id: identity.expected_activation_id,
        });
        expect(Value.Check(ApplicationActivationIdSchema, output.activation_id)).toBe(true);
        expect(f.calls.map(call => call.method)).toEqual(["GET", "POST"]);
        expect(result.content[0]!.text).not.toContain("must-not-escape");
    } finally { await f.server.stop(true); }
});

test("older servers cannot trigger a guessed default rollback", async () => {
    const f = rollbackHttp({}, "not-found");
    try {
        const result = await runAppTool(defaultRollback, { projectRef: identity.ref, getApplications: () => f.delegate });
        expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: false, error: { code: "HTTP_ERROR", http_status: 404 } });
        expect(f.calls.map(call => call.method)).toEqual(["GET"]);
    } finally { await f.server.stop(true); }
});

test("default rollback rejects mixed configuration/CAS flags before HTTP", async () => {
    const f = rollbackHttp(rollbackSnapshot());
    try {
        for (const flags of [
            { configuration_id: identity.configuration_id },
            { expected_activation_id: identity.expected_activation_id },
        ]) {
            await expect(runAppTool({ ...defaultRollback, ...flags },
                { projectRef: identity.ref, getApplications: () => f.delegate })).rejects.toThrow("cannot mix");
        }
        expect(f.calls).toEqual([]);
    } finally { await f.server.stop(true); }
});

test("default rollback rejects reused current or previous activation IDs before POST", async () => {
    const snapshot = rollbackSnapshot();
    const f = rollbackHttp(snapshot);
    try {
        for (const activation_id of [snapshot.active.activation_id, snapshot.previous.activation_id]) {
            await expect(runAppTool({ ...defaultRollback, activation_id },
                { projectRef: identity.ref, getApplications: () => f.delegate })).rejects.toThrow("new activation ID");
        }
        expect(f.calls.map(call => call.method)).toEqual(["GET", "GET"]);
    } finally { await f.server.stop(true); }
});

test("CLI default rollback and rollback-plan retain context and production/read-only guards", async () => {
    const root = await fixture();
    const f = rollbackHttp(rollbackSnapshot());
    const variables = {
        SUPACLOUD_API_URL: f.server.url.toString(), SUPACLOUD_API_TOKEN: "local-rollback-fixture",
        SUPACLOUD_PROJECT_REF: identity.ref,
    };
    const args = ["--id", identity.id, "--environment_id", identity.environment_id];
    try {
        const readOnly = await cli(root, ["app", "rollback", ...args], { ...variables, SUPACLOUD_READ_ONLY: "true" });
        expect(readOnly.code).toBe(1);
        expect(f.calls).toEqual([]);
        const unconfirmed = await cli(root, ["app", "rollback", ...args], { ...variables, SUPACLOUD_ENV: "production" });
        expect(unconfirmed.code).toBe(1);
        expect(f.calls).toEqual([]);
        const plan = await cli(root, ["app", "rollback-plan", ...args], { ...variables, SUPACLOUD_READ_ONLY: "true" });
        expect(plan.code, plan.output).toBe(0);
        expect(JSON.parse(plan.output)).toMatchObject({ operation: "applications.get_rollback_snapshot" });
        const rollback = await cli(root, ["app", "rollback", ...args], variables);
        expect(rollback.code, rollback.output).toBe(0);
        expect(JSON.parse(rollback.output)).toMatchObject({
            operation: "applications.rollback_release", configuration_id: identity.configuration_id,
        });
        expect(f.calls.map(call => call.method)).toEqual(["GET", "GET", "POST"]);
    } finally {
        await f.server.stop(true);
        await rm(root, { recursive: true, force: true });
    }
}, 30_000);
