import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildDeliveryProject } from "./delivery-build";
import { deliveryObjectDigest, parseDeliveryBuildManifest } from "./delivery-build-schema";
import { requireValue, writeFixtureProject } from "./fixtures/helpers";
import { FIXTURE_TSCONFIG, RUNTIME_SOURCE } from "./fixtures/runtime-source";

const hostSource = `import { createWorker, type CompiledModule } from "@supacloud/elysia";
export function createDeliveryWorker(modules: CompiledModule[]) {
  let claimed: boolean = false;
  // A deterministic test transport, not durable-queue or deployment evidence.
  const worker = createWorker({
    modules, workerId: "fixture-worker", pollIntervalMs: 10,
    transport: {
      async claim(signal) {
        signal.throwIfAborted();
        if (claimed) return null;
        claimed = true;
        return {id: "one", jobName: "report.render", input: {value: "compiled"}};
      },
      async ack(_claim, output) {
        if (process.env.JOB_RECEIPT) await Bun.write(process.env.JOB_RECEIPT, JSON.stringify(output));
      },
      fail() {throw new Error("Fixture Job failed");},
    },
  });
  return {
    start: () => worker.start(),
    async close() {
      await worker.stop();
      if (process.env.CLOSE_RECEIPT) await Bun.write(process.env.CLOSE_RECEIPT, "closed");
    },
  };
}`;

async function fixture() {
  const project = await mkdtemp(join(tmpdir(), "delivery-worker-"));
  await mkdir(join(project, "node_modules/@supacloud"), { recursive: true });
  await symlink(resolve(import.meta.dir, "../../elysia"), join(project, "node_modules/@supacloud/elysia"));
  await symlink(resolve(import.meta.dir, "../../elysia/node_modules/elysia"), join(project, "node_modules/elysia"));
  await symlink(resolve(import.meta.dir, "../node_modules/@types"), join(project, "node_modules/@types"));
  await symlink(resolve(import.meta.dir, "../node_modules/bun-types"), join(project, "node_modules/bun-types"));
  await writeFixtureProject(project, {
    "package.json": JSON.stringify({name: "delivery-worker-fixture", private: true, type: "module"}),
    "tsconfig.json": FIXTURE_TSCONFIG.replace('"strict": true', '"strict": true, "skipLibCheck": true, "types": ["bun"]'),
    "src/runtime.ts": RUNTIME_SOURCE.replaceAll("() => {}", "(..._args: unknown[]) => {}"),
    "src/report.ts": `import { Job, Module } from "./runtime";
      @Job({name: "report.render", mode: "task", idempotency: "required"})
      export class RenderReport {async run(input: {value: string}): Promise<{rendered: string}> {
        if (process.env.JOB_STARTED) await Bun.write(process.env.JOB_STARTED, "executing");
        if (process.env.JOB_RELEASE) {
          while (!await Bun.file(process.env.JOB_RELEASE).exists()) await Bun.sleep(10);
        }
        return {rendered: input.value + "-job"};
      }}
      @Module({name: "report", jobs: [RenderReport]}) export class ReportModule {}`,
    "src/host.ts": hostSource,
  });
  return {
    project,
    options: {
      rootDir: join(project, "src"), outDir: join(project, "generated"),
      strict: false, generateClient: false, generatePermissions: false,
    },
    settings: {
      version: 1, runtime: {processIsolation: true, durableQueue: true, capabilities: []},
      build: {workerApplications: [{target: "jobs", source: "host.ts"}]},
    },
  };
}

async function started(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (!child.stdout || typeof child.stdout === "number") throw new Error("Missing worker output");
  const reader = child.stdout.getReader();
  let output = "";
  try {
    while (!output.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Worker exited before startup event");
      output += new TextDecoder().decode(chunk.value);
      if (output.length > 16_384) throw new Error("Unexpected startup output");
    }
    expect(JSON.parse(requireValue(output.split("\n")[0]))).toEqual({event: "delivery-worker-started"});
  } finally { reader.releaseLock(); }
}

async function fileReady(path: string, child: ReturnType<typeof Bun.spawn>): Promise<void> {
  while (!await Bun.file(path).exists()) {
    if (child.exitCode !== null) throw new Error("Worker exited before receipt");
    await Bun.sleep(10);
  }
}

test("worker artifacts execute compiled Jobs detached, preserve identity and close on both signals", async () => {
  const { project, options, settings } = await fixture();
  const detached = await mkdtemp(join(tmpdir(), "detached-worker-"));
  try {
    const result = await buildDeliveryProject(options, settings);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(parseDeliveryBuildManifest(JSON.parse(JSON.stringify(result.manifest)))).toEqual(result.manifest);
    const object = requireValue(result.manifest.objects[0]);
    expect(object.entryKind).toBe("bun-worker-application");
    expect(result.manifest.deploymentReady).toBe(false);
    expect(() => parseDeliveryBuildManifest({
      ...result.manifest, objects: [{...object, entryKind: "compiled-module-factory"}],
    })).toThrow("Invalid delivery object inventory");
    const wrongKind = {...object, entryKind: "bun-http-application" as const};
    expect(() => parseDeliveryBuildManifest({
      ...result.manifest, objects: [{...wrongKind, objectId: deliveryObjectDigest(wrongKind)}],
    })).toThrow("does not match its target");
    const bundle = join(options.outDir, "delivery/objects", object.objectId, "bundle");
    expect(JSON.parse(await readFile(join(bundle, "target.json"), "utf8")).entryKind).toBe("bun-worker-application");
    const again = await buildDeliveryProject(options, settings);
    if (!again.ok) throw new Error(JSON.stringify(again.diagnostics));
    expect(again.written).toEqual([]);
    expect(again.unchangedTargets).toEqual(["jobs"]);
    await cp(bundle, detached, {recursive: true});
    await rm(project, {recursive: true, force: true});
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const closeReceipt = join(detached, `close-${signal}`), jobReceipt = join(detached, `job-${signal}`);
      const jobStarted = join(detached, `started-${signal}`);
      const jobRelease = join(detached, `release-${signal}`);
      const child = Bun.spawn([process.execPath, "--no-env-file", join(detached, "index.js")], {
        cwd: detached, stdout: "pipe", stderr: "pipe",
        env: {
          PATH: process.env.PATH, CLOSE_RECEIPT: closeReceipt, JOB_RECEIPT: jobReceipt,
          JOB_STARTED: jobStarted, ...(signal === "SIGTERM" ? {JOB_RELEASE: jobRelease} : {}),
        },
      });
      const errors = new Response(child.stderr).text();
      const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
      try {
        await started(child);
        await fileReady(signal === "SIGTERM" ? jobStarted : jobReceipt, child);
        if (signal === "SIGTERM") expect(await Bun.file(jobReceipt).exists()).toBe(false);
        child.kill(signal);
        if (signal === "SIGTERM") {
          await Bun.sleep(30);
          expect(child.exitCode).toBeNull();
          await Bun.write(jobRelease, "release");
        }
        expect(await child.exited).toBe(0);
        expect(JSON.parse(await readFile(jobReceipt, "utf8"))).toEqual({rendered: "compiled-job"});
        expect(await readFile(closeReceipt, "utf8")).toBe("closed");
        expect(await errors).toBe("");
      } finally {
        clearTimeout(deadline);
        if (child.exitCode === null) {child.kill("SIGKILL"); await child.exited;}
        await errors;
      }
    }
  } finally {
    await rm(project, {recursive: true, force: true});
    await rm(detached, {recursive: true, force: true});
  }
}, 120_000);

test("worker host configuration and type failures preserve the selected immutable manifest", async () => {
  const { project, options, settings } = await fixture();
  try {
    const result = await buildDeliveryProject(options, settings);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const pointer = join(options.outDir, "delivery/delivery.manifest.json");
    const before = await readFile(pointer, "utf8");
    for (const workerApplications of [
      [{target: "unknown", source: "host.ts"}],
      [{target: "jobs", source: "missing.ts"}],
      [{target: "jobs", source: "../host.ts"}],
      [{target: "jobs", source: "linked.ts"}],
      [{target: "jobs", source: "host.ts"}, {target: "jobs", source: "host.ts"}],
    ]) {
      const linked = workerApplications.some(host => host.source === "linked.ts");
      if (linked) await symlink(join(project, "src/host.ts"), join(project, "src/linked.ts"));
      expect((await buildDeliveryProject(options, {...settings, build: {workerApplications}})).ok).toBe(false);
      expect(await readFile(pointer, "utf8")).toBe(before);
      if (linked) await rm(join(project, "src/linked.ts"));
    }
    expect((await buildDeliveryProject(options, {
      ...settings, build: {...settings.build, httpApplications: [{target: "jobs", source: "host.ts"}]},
    })).ok).toBe(false);
    await writeFixtureProject(project, {
      "src/host.ts": "export function createDeliveryWorker(_modules: unknown) {return {start: () => 42};}",
    });
    const invalid = await buildDeliveryProject(options, settings);
    expect(invalid.ok).toBe(false);
    expect(invalid.diagnostics.some(entry => entry.code === "delivery-generated-type-error")).toBe(true);
    expect(await readFile(pointer, "utf8")).toBe(before);
    await writeFixtureProject(project, {
      "src/host.ts": hostSource,
      "src/api.ts": `import {Module, Controller, Get} from "./runtime";
        @Controller("/health") export class Health {@Get("/") get(): string {return "ok";}}
        @Module({name: "health", controllers: [Health]}) export class HealthModule {}`,
    });
    expect((await buildDeliveryProject(options, {
      ...settings, build: {workerApplications: [{target: "api", source: "host.ts"}]},
    })).ok).toBe(false);
    expect(await readFile(pointer, "utf8")).toBe(before);
    await rm(join(project, "src/api.ts"));
    await writeFixtureProject(project, {"src/host.ts": hostSource.replace('"fixture-worker"', '"changed-worker"')});
    const changed = await buildDeliveryProject(options, settings);
    if (!changed.ok) throw new Error(JSON.stringify(changed.diagnostics));
    expect(changed.changedTargets).toEqual(["jobs"]);
    expect(changed.manifest.objects[0]?.objectId).not.toBe(result.manifest.objects[0]?.objectId);
    const factory = await buildDeliveryProject(options, {...settings, build: {}});
    if (!factory.ok) throw new Error(JSON.stringify(factory.diagnostics));
    expect(factory.manifest.objects[0]?.entryKind).toBe("compiled-module-factory");
  } finally {await rm(project, {recursive: true, force: true});}
}, 120_000);

test("worker lifecycle bounds cancellation and cleanup, suppresses premature startup and sanitizes errors", async () => {
  const { project, options, settings } = await fixture();
  const detached = await mkdtemp(join(tmpdir(), "worker-lifecycle-"));
  const marker = "PRIVATE_WORKER_ERROR";
  try {
    await writeFixtureProject(project, {
      "src/host.ts": `export async function createDeliveryWorker(_modules: unknown, {signal}: {signal: AbortSignal}) {
        const mode = process.env.WORKER_TEST_MODE;
        if (mode === "factory-error") throw new Error(${JSON.stringify(marker)});
        if (mode === "abort-error") signal.addEventListener("abort", () => {throw new Error(${JSON.stringify(marker)});});
        if (mode === "abort-rejection") signal.addEventListener("abort", async () => {throw new Error(${JSON.stringify(marker)});});
        const closed = Promise.withResolvers<void>();
        const failure = Promise.withResolvers<never>();
        const mark = async () => {if (process.env.INIT_RECEIPT) await Bun.write(process.env.INIT_RECEIPT, "initialized");};
        const wait = async () => {
          await new Promise<void>(resolve => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), {once: true});
          });
          await Bun.sleep(150);
        };
        if (mode?.startsWith("factory-")) {
          await mark();
          if (mode === "factory-wait") await wait();
          if (mode === "factory-stuck") await new Promise<void>(() => {});
        }
        const host = {
          failure: failure.promise,
          async start() {
            await mark();
            if (mode === "failure-before-start") failure.reject(new Error(${JSON.stringify(marker)}));
            if (mode === "failure-pending-start") {
              failure.reject(new Error(${JSON.stringify(marker)}));
              await closed.promise;
            }
            if (mode === "runtime-failure-signal") setTimeout(() => failure.reject(new Error(${JSON.stringify(marker)})), 10);
            if (mode === "runtime-fulfilled-failure") setTimeout(() => failure.resolve(undefined as never), 10);
            if (mode?.startsWith("start-error")) throw new Error(${JSON.stringify(marker)});
            if (mode === "start-wait") await wait();
            if (mode === "start-stuck") await new Promise<void>(() => {});
            if (mode === "start-needs-close") await closed.promise;
            if (mode === "runtime-error") setTimeout(() => {throw new Error(${JSON.stringify(marker)});}, 10);
            if (mode === "runtime-rejection") setTimeout(() => {void Promise.reject(new Error(${JSON.stringify(marker)}));}, 10);
          },
          async close() {
            closed.resolve();
            if (process.env.CLOSE_RECEIPT) {
              const file = Bun.file(process.env.CLOSE_RECEIPT);
              await Bun.write(file, (await file.exists() ? await file.text() : "") + "closed\\n");
            }
            if (mode?.endsWith("close-stuck")) await new Promise<void>(() => {});
            if (mode === "close-error") throw new Error(${JSON.stringify(marker)});
          },
        };
        if (mode?.startsWith("invalid-start")) host.start = undefined as unknown as typeof host.start;
        if (mode === "invalid-close") host.close = undefined as unknown as typeof host.close;
        return host;
      }`,
    });
    const result = await buildDeliveryProject(options, settings);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const object = requireValue(result.manifest.objects[0]);
    await cp(join(options.outDir, "delivery/objects", object.objectId, "bundle"), detached, {recursive: true});
    await rm(project, {recursive: true, force: true});
    for (const mode of ["factory-wait", "start-wait", "start-needs-close", "factory-stuck", "start-stuck", "factory-error",
      "start-error", "invalid-start", "invalid-close", "close-error", "close-stuck",
      "invalid-start-close-stuck", "start-error-close-stuck", "abort-error", "abort-rejection",
      "runtime-error", "runtime-rejection", "failure-before-start", "failure-pending-start",
      "runtime-failure-signal", "runtime-fulfilled-failure"]) {
      const closeReceipt = join(detached, `close-${mode}`), initReceipt = join(detached, `init-${mode}`);
      const child = Bun.spawn([process.execPath, "--no-env-file", join(detached, "index.js")], {
        cwd: detached, stdout: "pipe", stderr: "pipe",
        env: {
          PATH: process.env.PATH, WORKER_TEST_MODE: mode, CLOSE_RECEIPT: closeReceipt,
          INIT_RECEIPT: initReceipt, SHUTDOWN_TIMEOUT_MS: "700",
        },
      });
      const errors = new Response(child.stderr).text();
      const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        if (["factory-wait", "start-wait", "start-needs-close", "factory-stuck", "start-stuck"].includes(mode)) {
          await fileReady(initReceipt, child);
          child.kill("SIGTERM");
          await Bun.sleep(30);
          child.kill("SIGTERM");
          expect(await child.exited).toBe(mode.endsWith("-wait") || mode === "start-needs-close" ? 0 : 1);
          expect(await new Response(child.stdout).text()).toBe("");
        } else if (mode.startsWith("runtime-")) {
          await started(child);
          expect(await child.exited).toBe(1);
        } else if (mode.startsWith("close-") || mode.startsWith("abort-")) {
          await started(child);
          child.kill("SIGTERM");
          expect(await child.exited).toBe(1);
        } else {
          expect(await child.exited).toBe(1);
          expect(await new Response(child.stdout).text()).toBe("");
        }
        const noClose = ["factory-error", "factory-stuck", "invalid-close"].includes(mode);
        if (noClose) expect(await Bun.file(closeReceipt).exists()).toBe(false);
        else expect(await readFile(closeReceipt, "utf8")).toBe("closed\n");
        const stderr = await errors;
        expect(stderr).not.toContain(marker);
        if (mode.endsWith("-stuck")) expect(stderr).toContain("shutdown deadline exceeded");
        if (mode.endsWith("-wait") || mode === "start-needs-close") expect(stderr).toBe("");
        if (mode.startsWith("abort-") || mode.startsWith("runtime-")) expect(stderr).toContain("runtime failed");
      } finally {
        clearTimeout(deadline);
        if (child.exitCode === null) {child.kill("SIGKILL"); await child.exited;}
        await errors;
      }
    }
  } finally {
    await rm(project, {recursive: true, force: true});
    await rm(detached, {recursive: true, force: true});
  }
}, 120_000);
