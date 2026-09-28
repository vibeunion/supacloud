import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildDeliveryProject } from "./delivery-build";
import { planDeliveryProject } from "./delivery-plan";
import { parseDeliveryBuildManifest } from "./delivery-build-schema";
import { requireValue, writeFixtureProject } from "./fixtures/helpers";
import { FIXTURE_TSCONFIG, RUNTIME_SOURCE } from "./fixtures/runtime-source";
import { createDeliveryExecutionContextPack } from "./delivery-context";

const runtime = "@supacloud/elysia";
const hostSource = `import { createApplication, type CompiledModule } from ${JSON.stringify(runtime)};
export function createDeliveryApplication(modules: CompiledModule[]) {
  const app = createApplication({ modules });
  return {
    fetch: (request: Request) => app.handle(request),
    close: async () => {
      if (process.env.CLOSE_RECEIPT) await Bun.write(process.env.CLOSE_RECEIPT, "closed");
    },
  };
}`;

async function fixture() {
  const project = await mkdtemp(join(tmpdir(), "delivery-http-"));
  await mkdir(join(project, "node_modules/@supacloud"), { recursive: true });
  await symlink(resolve(import.meta.dir, "../../elysia"), join(project, "node_modules/@supacloud/elysia"));
  await symlink(resolve(import.meta.dir, "../../elysia/node_modules/elysia"), join(project, "node_modules/elysia"));
  await symlink(resolve(import.meta.dir, "../node_modules/@types"), join(project, "node_modules/@types"));
  await symlink(resolve(import.meta.dir, "../node_modules/bun-types"), join(project, "node_modules/bun-types"));
  await writeFixtureProject(project, {
    "package.json": JSON.stringify({name: "delivery-http-fixture", private: true, type: "module"}),
    "tsconfig.json": FIXTURE_TSCONFIG.replace('"strict": true', '"strict": true, "skipLibCheck": true, "types": ["bun"]'),
    "src/runtime.ts": RUNTIME_SOURCE.replaceAll("() => {}", "(..._args: unknown[]) => {}"),
    "src/health.ts": `import { Module, Controller, Get } from "./runtime";
      @Controller("/health") export class HealthController {
        @Get("/", {response: {type: "string"}}) status(): string {return "ready";}
      }
      @Module({name: "health", controllers: [HealthController]}) export class HealthModule {}`,
    "src/host.ts": hostSource,
  });
  return {
    project,
    options: {
      rootDir: join(project, "src"), outDir: join(project, "generated"),
      strict: false, generateClient: false, generatePermissions: false,
    },
    settings: { version: 1, build: { httpApplications: [{ target: "api", source: "host.ts" }] } },
  };
}

async function waitForListener(child: ReturnType<typeof Bun.spawn>): Promise<string> {
  if (typeof child.stdout === "number" || !child.stdout) throw new Error("Missing child output");
  const reader = child.stdout.getReader();
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  let text = "";
  try {
    while (!text.includes("\n")) {
      const next = await reader.read();
      if (next.done) throw new Error("HTTP delivery process exited before listening");
      text += new TextDecoder().decode(next.value);
    }
    const event: unknown = JSON.parse(requireValue(text.split("\n")[0]));
    if (!event || typeof event !== "object" || !("url" in event) || typeof event.url !== "string") {
      throw new Error("Invalid listener receipt");
    }
    return event.url;
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

test("detached execution feedback uses its verified build snapshot without current source", async () => {
  const { project, options, settings } = await fixture();
  const archive = await mkdtemp(join(tmpdir(), "delivery-feedback-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await writeFixtureProject(project, {
      "src/health.ts": `import { Module, Controller, Get } from "./runtime";
        @Controller("/health") export class HealthController {
          @Get("/", {response: {type: "string"}}) status(): string {throw new Error("private-business-value");}
        }
        @Module({name: "health", controllers: [HealthController]}) export class HealthModule {}`,
      "src/host.ts": `import { createApplication, type CompiledModule, type ExecutionEvent } from "@supacloud/elysia";
        export function createDeliveryApplication(modules: CompiledModule[]) {
          const events: ExecutionEvent[] = [];
          const app = createApplication({ modules, requestContext: () => ({ requestId: "delivered-feedback" }),
            onExecution: event => { events.push(event); } });
          return { fetch: (request: Request) => app.handle(request),
            async close() {
              if (process.env.EXECUTION_RECEIPT) await Bun.write(process.env.EXECUTION_RECEIPT, JSON.stringify({version: 1, events}));
            } };
        }`,
    });
    const built = await buildDeliveryProject(options, settings);
    if (!built.ok) throw new Error(JSON.stringify(built.diagnostics));
    const object = requireValue(built.manifest.objects[0]);
    await cp(join(project, "generated/delivery"), archive, { recursive: true });
    const manifest = join(archive, "delivery.manifest.json");
    const bundle = join(archive, "objects", object.objectId, "bundle");
    const observationPath = join(archive, "observations.json");
    await rm(project, { recursive: true, force: true });
    child = Bun.spawn([process.execPath, "--no-env-file", join(bundle, "index.js")], {
      cwd: archive, env: { PATH: process.env.PATH, PORT: "0", HOST: "127.0.0.1", EXECUTION_RECEIPT: observationPath },
      stdout: "pipe", stderr: "pipe",
    });
    if (!child.stderr || typeof child.stderr === "number") throw new Error("Missing child error stream");
    const errors = new Response(child.stderr).text();
    const timeout = setTimeout(() => child?.kill("SIGKILL"), 20_000);
    try {
      const origin = await waitForListener(child);
      expect((await fetch(new URL("/health", origin), { signal: AbortSignal.timeout(5_000) })).status).toBe(500);
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
      await errors;
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
      await errors;
    }
    const delivery = { target: "api", objectId: object.objectId };
    const observations = { ...JSON.parse(await readFile(observationPath, "utf8")), delivery };
    expect(JSON.stringify(observations)).not.toContain("private-business-value");
    const pack = await createDeliveryExecutionContextPack(manifest, "api", "health", observations, "delivered-feedback");
    expect(pack.correlation).toBe("verified-build-snapshot");
    expect(pack.delivery).toEqual({ ...delivery, artifactVerified: true });
    expect(pack.deploymentVerified).toBe(false);
    expect(pack.eventsTrusted).toBe(false);
    expect(pack.events.some(event => event.phase === "failed" && event.stage === "handler")).toBe(true);
    expect(JSON.stringify(pack)).not.toContain("private-business-value");
    expect(JSON.stringify(pack)).not.toContain(project);
    await Bun.write(observationPath, JSON.stringify(observations));
    const cli = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "cli.ts"),
      "context", "health", "--delivery-manifest", manifest, "--delivery-target", "api",
      "--events", observationPath, "--request-id", "delivered-feedback", "--json"], {
      cwd: archive, env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe",
    });
    const cliTimeout = setTimeout(() => cli.kill("SIGKILL"), 15_000);
    try {
      const [code, output, stderr] = await Promise.all([
        cli.exited, new Response(cli.stdout).text(), new Response(cli.stderr).text(),
      ]);
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(output)).toEqual(pack);
    } finally {
      clearTimeout(cliTimeout);
      if (cli.exitCode === null) { cli.kill("SIGKILL"); await cli.exited; }
    }
    await expect(createDeliveryExecutionContextPack(manifest, "api", "health",
      { ...observations, delivery: { ...delivery, objectId: "0".repeat(64) } }, "delivered-feedback"))
      .rejects.toThrow("DELIVERY_CONTEXT_IDENTITY_MISMATCH");
    await expect(createDeliveryExecutionContextPack(manifest, "jobs", "health", observations, "delivered-feedback"))
      .rejects.toThrow("DELIVERY_CONTEXT_IDENTITY_MISMATCH");
    await expect(createDeliveryExecutionContextPack(manifest, "api", "health",
      { ...observations, token: "never-echo-this" }, "delivered-feedback")).rejects.toThrow("DELIVERY_CONTEXT_INVALID");
    const originalManifest = await readFile(manifest, "utf8");
    const renamed = JSON.parse(originalManifest);
    renamed.objects[0].name = "renamed";
    renamed.plan.targets[0].name = "renamed";
    for (const route of renamed.routes) route.target = "renamed";
    expect(() => parseDeliveryBuildManifest(renamed)).not.toThrow();
    await Bun.write(manifest, JSON.stringify(renamed));
    await expect(createDeliveryExecutionContextPack(manifest, "renamed", "health",
      { ...observations, delivery: { ...delivery, target: "renamed" } }, "delivered-feedback"))
      .rejects.toThrow("DELIVERY_CONTEXT_INTEGRITY_FAILED");
    await Bun.write(manifest, originalManifest);
    const snapshotPath = join(bundle, "execution-context.json");
    const snapshot = await readFile(snapshotPath, "utf8");
    await Bun.write(snapshotPath, snapshot + " ");
    await expect(createDeliveryExecutionContextPack(manifest, "api", "health", observations, "delivered-feedback"))
      .rejects.toThrow("DELIVERY_CONTEXT_INTEGRITY_FAILED");
    await Bun.write(snapshotPath, snapshot);
    const executablePath = join(bundle, "index.js");
    const executable = await readFile(executablePath);
    await Bun.write(executablePath, "invalid executable");
    await expect(createDeliveryExecutionContextPack(manifest, "api", "health", observations, "delivered-feedback"))
      .rejects.toThrow("DELIVERY_CONTEXT_INTEGRITY_FAILED");
    await Bun.write(executablePath, executable);
    await Bun.write(join(bundle, "unlisted-file"), "not part of the verified build");
    await expect(createDeliveryExecutionContextPack(manifest, "api", "health", observations, "delivered-feedback"))
      .rejects.toThrow("DELIVERY_CONTEXT_INTEGRITY_FAILED");
    await rm(join(bundle, "unlisted-file"));
    await rm(snapshotPath);
    await expect(createDeliveryExecutionContextPack(manifest, "api", "health", observations, "delivered-feedback"))
      .rejects.toThrow("DELIVERY_CONTEXT_INTEGRITY_FAILED");
    await symlink(observationPath, snapshotPath);
    await expect(createDeliveryExecutionContextPack(manifest, "api", "health", observations, "delivered-feedback"))
      .rejects.toThrow("DELIVERY_CONTEXT_INTEGRITY_FAILED");
  } finally {
    if (child?.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    await rm(project, { recursive: true, force: true });
    await rm(archive, { recursive: true, force: true });
  }
}, 120_000);

test("HTTP artifacts run detached, retain compiled routes, reuse identity and close on both signals", async () => {
  const { project, options, settings } = await fixture();
  const detached = await mkdtemp(join(tmpdir(), "detached-http-"));
  try {
    const result = await buildDeliveryProject(options, settings);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(parseDeliveryBuildManifest(JSON.parse(JSON.stringify(result.manifest)))).toEqual(result.manifest);
    expect(result.manifest.deploymentReady).toBe(false);
    const object = requireValue(result.manifest.objects[0]);
    expect(object.entryKind).toBe("bun-http-application");
    expect(() => parseDeliveryBuildManifest({
      ...result.manifest, objects: [{ ...object, entryKind: "compiled-module-factory" }],
    })).toThrow("Invalid delivery object inventory");
    const bundle = join(project, "generated/delivery/objects", object.objectId, "bundle");
    const metadata = JSON.parse(await readFile(join(bundle, "target.json"), "utf8"));
    expect(metadata.entryKind).toBe("bun-http-application");
    expect(metadata.deploymentReady).toBe(false);
    const second = await buildDeliveryProject(options, settings);
    if (!second.ok) throw new Error(JSON.stringify(second.diagnostics));
    expect(second.written).toEqual([]);
    expect(second.unchangedTargets).toEqual(["api"]);
    const script = `import {buildDeliveryProject} from ${JSON.stringify(join(import.meta.dir, "delivery-build.ts"))};
      console.log(JSON.stringify(await buildDeliveryProject(${JSON.stringify(options)}, ${JSON.stringify(settings)})));`;
    const otherDirectory = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
      cwd: tmpdir(), stdout: "pipe", stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([
      otherDirectory.exited, new Response(otherDirectory.stdout).text(), new Response(otherDirectory.stderr).text(),
    ]);
    expect(status).toBe(0);
    expect(stderr).toBe("");
    const outsideBuild = JSON.parse(stdout);
    expect(outsideBuild.ok).toBe(true);
    expect(outsideBuild.written).toEqual([]);
    expect(outsideBuild.manifest.objects[0].objectId).toBe(object.objectId);
    await cp(bundle, detached, { recursive: true });
    // Removing both source and dependency links makes portability an observed property.
    await rm(project, { recursive: true, force: true });
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const receipt = join(detached, `closed-${signal}`);
      const child = Bun.spawn([process.execPath, "--no-env-file", join(detached, "index.js")], {
        cwd: detached, env: { PATH: process.env.PATH, PORT: "0", HOST: "127.0.0.1", CLOSE_RECEIPT: receipt },
        stdout: "pipe", stderr: "pipe",
      });
      const errors = new Response(child.stderr).text();
      try {
        const url = await waitForListener(child).catch(async (error: unknown) => {
          throw new Error(`${String(error)}: ${await errors}`);
        });
        const response = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(5_000) });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("ready");
        expect((await fetch(new URL("/missing", url))).status).toBe(404);
        child.kill(signal);
        const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
        try { expect(await child.exited).toBe(0); }
        finally { clearTimeout(timeout); }
        expect(await readFile(receipt, "utf8")).toBe("closed");
        expect(await errors).toBe("");
      } finally {
        if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
        await errors;
      }
    }
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(detached, { recursive: true, force: true });
  }
}, 120_000);

test("invalid HTTP host declarations and type errors preserve the previous immutable build", async () => {
  const { project, options, settings } = await fixture();
  try {
    const initial = await buildDeliveryProject(options, settings);
    if (!initial.ok) throw new Error(JSON.stringify(initial.diagnostics));
    const pointer = join(project, "generated/delivery/delivery.manifest.json");
    const before = await readFile(pointer, "utf8");
    for (const httpApplications of [
      [{ target: "unknown", source: "host.ts" }],
      [{ target: "api", source: "missing.ts" }],
      [{ target: "api", source: "../host.ts" }],
      [{ target: "api", source: "linked.ts" }],
      [{ target: "api", source: "host.ts" }, { target: "api", source: "host.ts" }],
    ]) {
      const linked = httpApplications.some((app) => app.source === "linked.ts");
      if (linked) await symlink(join(project, "src/host.ts"), join(project, "src/linked.ts"));
      const rejected = await buildDeliveryProject(options, { version: 1, build: { httpApplications } });
      expect(rejected.ok).toBe(false);
      expect(await readFile(pointer, "utf8")).toBe(before);
      if (linked) await rm(join(project, "src/linked.ts"));
    }
    await writeFixtureProject(project, {
      "src/host.ts": "export function createDeliveryApplication(_modules: unknown) { return { fetch: () => 42 }; }",
    });
    const invalidType = await buildDeliveryProject(options, settings);
    expect(invalidType.ok).toBe(false);
    expect(invalidType.diagnostics.some((diagnostic) => diagnostic.code === "delivery-generated-type-error")).toBe(true);
    expect(await readFile(pointer, "utf8")).toBe(before);
    await writeFixtureProject(project, {
      "src/host.ts": hostSource,
      "src/job.ts": `import {Job, Module} from "./runtime";
        @Job({name: "health.check"}) export class HealthJob {run(): string {return "ok";}}
        @Module({name: "worker", jobs: [HealthJob]}) export class WorkerModule {}`,
    });
    const jobHost = {
      version: 1, runtime: {processIsolation: true, durableQueue: true, capabilities: []},
      build: {httpApplications: [{target: "jobs", source: "host.ts"}]},
    };
    expect((await planDeliveryProject(options, jobHost)).ok).toBe(true);
    expect((await buildDeliveryProject(options, jobHost)).ok).toBe(false);
    expect(await readFile(pointer, "utf8")).toBe(before);
    await rm(join(project, "src/job.ts"));
    await writeFixtureProject(project, { "src/host.ts": hostSource.replace('createApplication({ modules })', 'createApplication({ modules, name: "changed-host" })') });
    const changed = await buildDeliveryProject(options, settings);
    if (!changed.ok) throw new Error(JSON.stringify(changed.diagnostics));
    expect(changed.changedTargets).toEqual(["api"]);
    expect(changed.manifest.objects[0]?.objectId).not.toBe(initial.manifest.objects[0]?.objectId);
  } finally { await rm(project, { recursive: true, force: true }); }
}, 120_000);

test("HTTP lifecycle cancels initialization, bounds streaming and cleanup, and sanitizes failures", async () => {
  const { project, options, settings } = await fixture();
  const detached = await mkdtemp(join(tmpdir(), "delivery-lifecycle-"));
  const marker = "PRIVATE_HOST_ERROR";
  try {
    await writeFixtureProject(project, {
      "src/host.ts": `import { createApplication, type CompiledModule } from ${JSON.stringify(runtime)};
        export async function createDeliveryApplication(modules: CompiledModule[], {signal}: {signal: AbortSignal}) {
          const mode = process.env.HOST_TEST_MODE;
          if (mode === "startup-error") throw new Error(${JSON.stringify(marker)});
          if (process.env.INIT_RECEIPT) await Bun.write(process.env.INIT_RECEIPT, "initialized");
          if (mode === "startup-wait") {
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", () => resolve(), {once: true});
            });
            await Bun.sleep(150);
          }
          const app = createApplication({modules});
          let fetch: (request: Request) => Response | Promise<Response> = (request) => app.handle(request);
          if (mode?.startsWith("invalid-fetch")) fetch = undefined as unknown as typeof fetch;
          if (mode === "fetch-error") fetch = () => {throw new Error(${JSON.stringify(marker)});};
          if (mode === "stream") fetch = () => new Response(new ReadableStream({
            start(controller) {controller.enqueue(new TextEncoder().encode("open\\n"));}
          }));
          return {fetch, async close() {
            if (process.env.CLOSE_RECEIPT) {
              const file = Bun.file(process.env.CLOSE_RECEIPT);
              await Bun.write(file, (await file.exists() ? await file.text() : "") + "closed\\n");
            }
            if (mode?.endsWith("close-stuck")) await new Promise<void>(() => {});
          }};
        }`,
    });
    const result = await buildDeliveryProject(options, { ...settings, build: { ...settings.build, minify: false } });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const object = requireValue(result.manifest.objects[0]);
    await cp(join(project, "generated/delivery/objects", object.objectId, "bundle"), detached, { recursive: true });
    await rm(project, { recursive: true, force: true });
    for (const mode of ["startup-wait", "invalid-fetch", "startup-error", "stream", "close-stuck", "fetch-error",
      "bind-error", "invalid-fetch-close-stuck", "bind-error-close-stuck"]) {
      const occupied = mode.startsWith("bind-error") ? Bun.serve({hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy")}) : undefined;
      const receipt = join(detached, `closed-${mode}`);
      const initialized = join(detached, `init-${mode}`);
      const child = Bun.spawn([process.execPath, "--no-env-file", join(detached, "index.js")], {
        cwd: detached, stdout: "pipe", stderr: "pipe",
        env: {
          PATH: process.env.PATH, PORT: String(occupied?.port ?? 0), HOST: "127.0.0.1",
          HOST_TEST_MODE: mode, CLOSE_RECEIPT: receipt, INIT_RECEIPT: initialized, SHUTDOWN_TIMEOUT_MS: "1000",
        },
      });
      const errors = new Response(child.stderr).text();
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
      let response: Response | undefined;
      try {
        if (mode === "startup-wait") {
          while (!await Bun.file(initialized).exists()) {
            if (child.exitCode !== null) throw new Error("Initialization exited prematurely");
            await Bun.sleep(10);
          }
          child.kill("SIGTERM");
          await Bun.sleep(30);
          child.kill("SIGTERM");
          expect(await child.exited).toBe(0);
          expect(await new Response(child.stdout).text()).toBe("");
        } else if (mode.startsWith("invalid-fetch") || mode.startsWith("bind-error") || mode === "startup-error") {
          expect(await child.exited).toBe(1);
        } else {
          const url = await waitForListener(child);
          response = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(5_000) });
          if (mode === "fetch-error") {
            expect(response.status).toBe(500);
            expect(await response.text()).toBe("Internal Server Error");
          } else if (mode === "stream") {
            const reader = response.body?.getReader();
            expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("open\n");
            reader?.releaseLock();
          } else {
            expect(await response.text()).toBe("ready");
          }
          child.kill("SIGTERM");
          expect(await child.exited).toBe(mode === "fetch-error" ? 0 : 1);
        }
        if (mode !== "startup-error") expect(await readFile(receipt, "utf8")).toBe("closed\n");
        const stderr = await errors;
        expect(stderr).not.toContain(marker);
        if (mode.endsWith("close-stuck")) expect(stderr).toContain("shutdown deadline exceeded");
        if (mode === "stream") expect(stderr).toContain("shutdown failed");
        if (mode === "startup-wait" || mode === "fetch-error") expect(stderr).toBe("");
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
        await response?.body?.cancel().catch(() => {});
        await errors;
        await occupied?.stop(true);
      }
    }
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(detached, { recursive: true, force: true });
  }
}, 120_000);
