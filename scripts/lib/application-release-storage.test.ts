import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildDeliveryProject } from "../../packages/compiler/dist/index.js";
import { readDeliveryExecutableArchive } from "../../packages/delivery/src";
import { GOOD_PROJECT_FILES } from "../../packages/compiler/src/fixtures/good-project";
import { writeFixtureProject } from "../../packages/compiler/src/fixtures/helpers";
import { ApplicationReleaseStorage, type ImportApplicationRelease } from "../../packages/management-api/src/services/application-release-storage";
import { createApplicationRoutes } from "../../packages/management-api/src/routes/applications";
import { HttpTransport } from "../../packages/cli/src/shared/transports/http";
import { registerApplicationTools } from "../../packages/cli/src/shared/tools/application-tools";
import type { ReleaseControlToolResponse } from "../../packages/cli/src/shared/tools/release-control-response";
import { ApplicationRuntimeFiles } from "../../packages/management-api/src/services/application-runtime-files";
import { applicationRuntimePlan, ApplicationSystemdRuntime } from "../../packages/management-api/src/services/application-runtime";
import { ApplicationReadiness } from "../../packages/management-api/src/services/application-readiness";
import { ApplicationMigrations } from "../../packages/management-api/src/services/application-migrations";
import { calculateMigrationChecksum } from "../../packages/management-api/src/services/migration-promotion";
import { ApplicationDeploymentService } from "../../packages/management-api/src/services/application-deployment";
import { ApplicationActiveStorage } from "../../packages/management-api/src/services/application-active-storage";
import { CaddyGatewayProvider } from "../../packages/management-api/src/services/gateway.service";
import { config } from "../../packages/management-api/src/config";
import { activationJournal } from "../../packages/management-api/tests/helpers/application-activation-journal";
import { assertManagedSystemdUnitContent } from "../../packages/management-api/src/services/systemd-unit-broker";

let fixture: string;
let archive: string;
let factoryArchive: string;
let root: string;
let storage: ApplicationReleaseStorage;
let input: ImportApplicationRelease;

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), "application-release-build-"));
  const project = join(fixture, "project");
  await mkdir(join(project, "node_modules"), { recursive: true });
  for (const name of ["@types", "bun-types"]) {
    await symlink(resolve(import.meta.dir, "../../packages/compiler/node_modules", name),
      join(project, "node_modules", name));
  }
  await writeFixtureProject(project, {
    ...GOOD_PROJECT_FILES,
    "tsconfig.json": GOOD_PROJECT_FILES["tsconfig.json"]!.replace(
      '"strict": true', '"strict": true, "skipLibCheck": true, "types": ["bun"]'),
    "src/runtime.ts": GOOD_PROJECT_FILES["src/runtime.ts"]!.replaceAll("() => {}", "(..._args: unknown[]) => {}"),
    "src/report.ts": `import { Job, Module } from "./runtime";
      @Job({name: "report.render", mode: "task", idempotency: "required"})
      export class RenderReport { async run(input: {value: string}): Promise<{value: string}> { return input; } }
      @Module({name: "report", jobs: [RenderReport]}) export class ReportModule {}`,
    "src/host.ts": `export function createDeliveryApplication(_modules: unknown[]) {
      let ready = true;
      return {fetch: (request: Request) => {
        if (new URL(request.url).pathname === "/not-ready") ready = false;
        return new Response("ready");
      }, ready: () => ready, close() {}};
    }`,
    "src/worker.ts": `export function createDeliveryWorker(_modules: unknown[]) {
      return {start() {}, close() {}};
    }`,
    "migrations/001.sql": "CREATE TABLE public.release_example(id integer);\n",
  });
  const options = {
    rootDir: join(project, "src"), outDir: join(project, "generated"), strict: false,
    generateClient: false, generatePermissions: false,
  };
  const settings = {
    version: 1, runtime: { processIsolation: true, durableQueue: true, capabilities: [] },
    build: {
      migrations: [{ source: "migrations/001.sql", version: "1", name: "example", executor: "project-migration" }],
      httpApplications: [{ target: "api", source: "host.ts" }],
      workerApplications: [{ target: "jobs", source: "worker.ts" }],
    },
  };
  const built = await buildDeliveryProject(options, settings);
  if (!built.ok) throw new Error(JSON.stringify(built.diagnostics));
  archive = join(fixture, "archive");
  await cp(join(options.outDir, "delivery"), archive, { recursive: true });
  const factory = await buildDeliveryProject(options, { ...settings, build: {} });
  if (!factory.ok) throw new Error(JSON.stringify(factory.diagnostics));
  factoryArchive = join(fixture, "factory");
  await cp(join(options.outDir, "delivery"), factoryArchive, { recursive: true });
  await rm(project, { recursive: true });
}, 60_000);

afterAll(async () => { if (fixture) await rm(fixture, { recursive: true, force: true }); });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "application-release-store-"));
  const upload = join(root, "upload");
  await cp(archive, upload, { recursive: true });
  const manifestPath = join(upload, "delivery.manifest.json");
  const verified = await readDeliveryExecutableArchive(manifestPath);
  input = {
    projectRef: "project-one", applicationId: "reviews", manifestPath,
    expectedObjects: Object.fromEntries(verified.objects.map(({ object }) => [object.name, object.objectId])),
  };
  storage = new ApplicationReleaseStorage(join(root, "store"));
});
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

function stored(id: string): string {
  return join(root, "store", input.projectRef, input.applicationId, "releases", id);
}

test("imports a detached real HTTP/Worker build as one durable application release", async () => {
  const record = await storage.importRelease(input);
  expect(record.targets.map(target => target.kind).sort()).toEqual(["http", "worker"]);
  expect(Object.fromEntries(record.targets.map(target => [target.name, target.object_id]))).toEqual(input.expectedObjects);
  expect(record.project_ref).toBe(input.projectRef);
  expect(record.application_id).toBe(input.applicationId);
  await rm(dirname(input.manifestPath), { recursive: true });
  const restarted = new ApplicationReleaseStorage(join(root, "store"));
  expect(await restarted.readRelease(input.projectRef, input.applicationId, record.release_id)).toEqual(record);
  const manifest = JSON.parse(await readFile(join(stored(record.release_id), "delivery.manifest.json"), "utf8"));
  expect(manifest.deploymentReady).toBe(false);
  expect(await readdir(dirname(stored(record.release_id)))).toEqual([record.release_id]);
});

test("stored detached release migration inventory uses verified bytes for every target", async () => {
  const release = await storage.importRelease(input);
  const inventory = await storage.readMigrations(input.projectRef, input.applicationId, release.release_id);
  expect(inventory.archives.map(entry => entry.target).sort()).toEqual(release.targets.map(entry => entry.name).sort());
  const migration = inventory.archives[0]!.migrations[0]!;
  const migrations = new ApplicationMigrations({
    storage,
    inventory: async () => [{
      version: migration.version, name: migration.name, statements: [migration.sql.trim()],
      statement_count: 1, applied_at: null,
      checksum: calculateMigrationChecksum({ version: migration.version, name: migration.name, statements: [migration.sql] }),
    }],
  });
  const app = createApplicationRoutes({
    storage, migrations, authorize: async () => undefined, projectExists: async () => true,
  });
  const response = await app.handle(new Request(
    `http://localhost/v1/projects/${input.projectRef}/applications/${input.applicationId}/releases/${release.release_id}/migrations`,
  ));
  expect(response.status).toBe(200);
  const report = await response.json();
  expect(report).toMatchObject({ project_migrations_applied: true, compatibility: "not-proven" });
  expect(report.targets).toHaveLength(release.targets.length);
  expect(JSON.stringify(report)).not.toContain("CREATE TABLE");
  const target = release.targets[0]!;
  await writeFile(join(stored(release.release_id),
    "objects", target.object_id, "bundle", migration.path), "SELECT 999");
  await expect(storage.readMigrations(input.projectRef, input.applicationId, release.release_id)).rejects.toThrow();
});

test("concurrent and repeated imports reuse the original record without replacing it", async () => {
  const records = await Promise.all([storage.importRelease(input), storage.importRelease(input)]);
  expect(records[0]).toEqual(records[1]);
  expect(await storage.importRelease(input)).toEqual(records[0]!);
  expect(await readdir(dirname(stored(records[0]!.release_id)))).toEqual([records[0]!.release_id]);
});

test("release identity is bound to project and application, with expected object checks", async () => {
  await expect(storage.readRelease(input.projectRef, input.applicationId, "0".repeat(64))).rejects.toThrow();
  expect(await readdir(root)).toEqual(["upload"]);
  const first = await storage.importRelease(input);
  const second = await storage.importRelease({ ...input, applicationId: "other" });
  const third = await storage.importRelease({ ...input, projectRef: "project-two" });
  expect(new Set([first.release_id, second.release_id, third.release_id]).size).toBe(3);
  await expect(storage.readRelease(input.projectRef, "other", first.release_id)).rejects.toThrow();
  await expect(storage.importRelease({ ...input, expectedObjects: { ...input.expectedObjects, api: "0".repeat(64) } }))
    .rejects.toThrow("APPLICATION_RELEASE_OBJECT_MISMATCH");
  await expect(storage.importRelease({ ...input, expectedObjects: { api: input.expectedObjects.api! } }))
    .rejects.toThrow("APPLICATION_RELEASE_OBJECT_MISMATCH");
  await expect(storage.importRelease({ ...input, applicationId: "../escape" })).rejects.toThrow();
});

test("rejects tampered or unexpected source files before publishing", async () => {
  const entrypoint = join(dirname(input.manifestPath), "objects", input.expectedObjects.api!, "bundle/index.js");
  const original = await readFile(entrypoint);
  await writeFile(entrypoint, "throw new Error('must not execute');");
  await expect(storage.importRelease(input)).rejects.toThrow("Artifact hash mismatch");
  await writeFile(entrypoint, original);
  await writeFile(join(dirname(entrypoint), "unlisted.js"), "unexpected");
  await expect(storage.importRelease(input)).rejects.toThrow("Unexpected artifact entry");
  expect(await readdir(dirname(stored("placeholder")))).toEqual([]);
});

test("rejects factory-only builds and source symlinks", async () => {
  await expect(storage.importRelease({ ...input, manifestPath: join(factoryArchive, "delivery.manifest.json") }))
    .rejects.toThrow("Invalid executable delivery inventory");
  const entrypoint = join(dirname(input.manifestPath), "objects", input.expectedObjects.api!, "bundle/index.js");
  await writeFile(join(root, "external.js"), await readFile(entrypoint));
  await rm(entrypoint);
  await symlink(join(root, "external.js"), entrypoint);
  await expect(storage.importRelease(input)).rejects.toThrow();
  expect(await readdir(dirname(stored("placeholder")))).toEqual([]);
});

test("detects stored corruption on read and repeat import rather than overwriting it", async () => {
  const record = await storage.importRelease(input);
  const entrypoint = join(stored(record.release_id), "objects", input.expectedObjects.api!, "bundle/index.js");
  await writeFile(entrypoint, "corrupted");
  await expect(storage.readRelease(input.projectRef, input.applicationId, record.release_id)).rejects.toThrow();
  await expect(storage.importRelease(input)).rejects.toThrow();
  expect(await readFile(entrypoint, "utf8")).toBe("corrupted");
  expect(await readdir(dirname(stored(record.release_id)))).toEqual([record.release_id]);
});

test("rejects a stored receipt whose target no longer matches its manifest", async () => {
  const record = await storage.importRelease(input);
  await writeFile(join(stored(record.release_id), "release.json"), JSON.stringify({
    ...record, targets: record.targets.map(target => ({ ...target, kind: "worker" })),
  }));
  await expect(storage.readRelease(input.projectRef, input.applicationId, record.release_id))
    .rejects.toThrow("APPLICATION_RELEASE_INVALID");
});

async function uploadForm(): Promise<FormData> {
  const verified = await readDeliveryExecutableArchive(input.manifestPath);
  const form = new FormData();
  form.set("manifest", JSON.stringify(verified.manifest));
  form.set("expected_objects", JSON.stringify(input.expectedObjects));
  for (const { object, files } of verified.objects) {
    for (const [name, bytes] of files) {
      form.set(`objects/${object.objectId}/${name}`, new Blob([Uint8Array.from(bytes)]), "artifact.bin");
    }
  }
  return form;
}

function routes() {
  return createApplicationRoutes({
    storage,
    authorize: async request => request.headers.get("authorization") === "Bearer local-test"
      ? undefined : { status: 401, body: { error: "Unauthorized" } },
    projectExists: async ref => ref === input.projectRef,
  });
}

test("CLI uploads a real compiler archive over HTTP and reads the same immutable receipt", async () => {
  const app = routes();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  try {
    let callback: ((args: Record<string, unknown>) => Promise<ReleaseControlToolResponse>) | undefined;
    registerApplicationTools({
      tool(_name, _description, _schema, handler) { callback = handler; },
    }, new HttpTransport({ baseUrl: server.url.toString(), token: "local-test" }));
    if (!callback) throw new Error("Applications tool missing");
    const args = { ref: input.projectRef, id: input.applicationId };
    const uploaded = JSON.parse((await callback({
      ...args, action: "upload_release", manifest_path: input.manifestPath,
    })).content[0]!.text);
    expect(uploaded).toMatchObject({ ok: true, operation: "applications.upload_release" });
    expect(uploaded.release.targets.map((target: { kind: string }) => target.kind).sort()).toEqual(["http", "worker"]);
    const duplicate = JSON.parse((await callback({
      ...args, action: "upload_release", manifest_path: input.manifestPath,
    })).content[0]!.text);
    expect(duplicate.release).toEqual(uploaded.release);
    const listed = JSON.parse((await callback({ ...args, action: "list_releases", limit: 1 })).content[0]!.text);
    expect(listed).toMatchObject({ ok: true, releases: [uploaded.release], next_cursor: null });
    const read = JSON.parse((await callback({
      ...args, action: "get_release", release_id: uploaded.release.release_id,
    })).content[0]!.text);
    expect(read.release).toEqual(uploaded.release);
    expect(await readdir(dirname(stored(uploaded.release.release_id)))).toEqual([uploaded.release.release_id]);
  } finally {
    await server.stop(true);
  }
}, 30_000);

test("application routes preserve auth, missing resources and validation responses", async () => {
  const app = routes();
  const base = `http://localhost/v1/projects/${input.projectRef}/applications/${input.applicationId}/releases`;
  const headers = { authorization: "Bearer local-test" };
  expect((await app.handle(new Request(base))).status).toBe(401);
  expect((await app.handle(new Request(base.replace(input.projectRef, "absent"), { headers }))).status).toBe(404);
  expect((await app.handle(new Request(`${base}/${"0".repeat(64)}`, { headers }))).status).toBe(404);
  expect((await app.handle(new Request(`${base}?limit=0`, { headers }))).status).toBe(422);
  expect(await (await app.handle(new Request(base, { headers }))).json()).toMatchObject({
    releases: [], next_cursor: null,
  });
  expect(await readdir(root)).toEqual(["upload"]);
});

test("multipart intake rejects invalid envelopes and tampering without publishing a release", async () => {
  const app = routes();
  const url = `http://localhost/v1/projects/${input.projectRef}/applications/${input.applicationId}/releases`;
  const headers = { authorization: "Bearer local-test" };
  const send = (body: FormData) => app.handle(new Request(url, { method: "POST", headers, body }));
  const missing = await uploadForm();
  missing.delete("expected_objects");
  expect((await send(missing)).status).toBe(400);
  const duplicate = await uploadForm();
  duplicate.append("manifest", String(duplicate.get("manifest")));
  expect((await send(duplicate)).status).toBe(400);
  const tampered = await uploadForm();
  const field = [...tampered.keys()].find(name => name.endsWith("/bundle/index.js"))!;
  const file = tampered.get(field) as File;
  tampered.set(field, new Blob([new Uint8Array(file.size)]), "artifact.bin");
  expect((await send(tampered)).status).toBe(400);
  expect((await app.handle(new Request(url, {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}",
  }))).status).toBe(415);
  expect((await app.handle(new Request(url, {
    method: "POST",
    headers: { ...headers, "content-type": "multipart/form-data; boundary=x", "content-length": "999999999" },
    body: "x",
  }))).status).toBe(413);
  expect(await storage.listReleases(input.projectRef, input.applicationId)).toMatchObject({ releases: [] });
});

test("CLI preserves the expected release ID when an upload receipt is unreadable", async () => {
  let callback: ((args: Record<string, unknown>) => Promise<ReleaseControlToolResponse>) | undefined;
  registerApplicationTools({
    tool(_name, _description, _schema, handler) { callback = handler; },
  }, { postMultipart: async () => ({ ok: true, status: 201, data: null }) } as unknown as HttpTransport);
  if (!callback) throw new Error("Applications tool missing");
  const response = JSON.parse((await callback({
    action: "upload_release", ref: input.projectRef, id: input.applicationId, manifest_path: input.manifestPath,
  })).content[0]!.text);
  expect(response).toMatchObject({ ok: false, error: { code: "OUTCOME_UNKNOWN" } });
  const storedRelease = await storage.importRelease(input);
  expect(response.release_id).toBe(storedRelease.release_id);
});

test("release inventory pages distinct builds without duplicates or omitted records", async () => {
  const first = await storage.importRelease(input);
  const manifest = JSON.parse(await readFile(input.manifestPath, "utf8"));
  manifest.plan.topologyDigest = "b".repeat(64);
  await writeFile(input.manifestPath, JSON.stringify(manifest));
  const second = await storage.importRelease(input);
  const expected = [first.release_id, second.release_id].sort();
  const page = await storage.listReleases(input.projectRef, input.applicationId, { limit: 1 });
  expect(page.releases.map(release => release.release_id)).toEqual(expected.slice(0, 1));
  expect(page.next_cursor).toBe(expected[0]!);
  const next = await storage.listReleases(input.projectRef, input.applicationId, {
    limit: 1, cursor: page.next_cursor!,
  });
  expect(next.releases.map(release => release.release_id)).toEqual(expected.slice(1));
  expect(next.next_cursor).toBeNull();
});

test("verified runtime preparation preserves compiled objects and refuses changed activation configuration", async () => {
  const release = await storage.importRelease(input);
  const runtimeInput = {
    release, activationId: "01234567-89ab-4def-8123-456789abcdef", environmentId: "local",
    ports: { api: 31000 },
  };
  const runtime = new ApplicationRuntimeFiles(storage, join(root, "runtime"));
  const environment = { api: { EXAMPLE: "test-value" }, jobs: {} };
  const directory = await runtime.prepare(runtimeInput, environment);
  expect(await runtime.prepare(runtimeInput, environment)).toBe(directory);
  const archive = await readDeliveryExecutableArchive(join(directory, "delivery.manifest.json"));
  expect(archive.manifest.objects.map(object => object.objectId).sort()).toEqual(Object.values(input.expectedObjects).sort());
  expect(await readFile(join(directory, "api.env"), "utf8")).toBe('EXAMPLE="test-value"\n');
  const plan = applicationRuntimePlan(runtimeInput);
  expect(plan.targets).toHaveLength(2);
  await expect(runtime.prepare(runtimeInput, { api: { EXAMPLE: "different" }, jobs: {} }))
    .rejects.toThrow("CONFIGURATION_CONFLICT");
  await expect(runtime.prepare(runtimeInput, { api: { PORT: "1234" }, jobs: {} }))
    .rejects.toThrow("ENVIRONMENT_INVALID");
  expect(await readFile(join(directory, "api.env"), "utf8")).toBe('EXAMPLE="test-value"\n');
});

test("prepared detached HTTP and Worker objects really start and drain on SIGTERM", async () => {
  const release = await storage.importRelease(input);
  const runtimeInput = {
    release, activationId: "01234567-89ab-4def-8123-456789abcdef", environmentId: "local",
    ports: { api: 31000 },
  };
  const directory = await new ApplicationRuntimeFiles(storage, join(root, "runtime"))
    .prepare(runtimeInput, { api: {}, jobs: {} });
  await rm(dirname(input.manifestPath), { recursive: true });
  for (const target of release.targets) {
    const child = Bun.spawn({
      cmd: [process.execPath, "--no-env-file", join(directory, "objects", target.object_id, target.entrypoint)],
      cwd: join(directory, "objects", target.object_id),
      env: { PATH: process.env.PATH ?? "", HOST: "127.0.0.1", PORT: "0", SHUTDOWN_TIMEOUT_MS: "2000" },
      stdout: "pipe", stderr: "ignore",
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 8000);
    try {
      const reader = child.stdout.getReader();
      const chunk = await reader.read();
      reader.releaseLock();
      expect(chunk.done).toBe(false);
      const message = JSON.parse(new TextDecoder().decode(chunk.value).trim());
      expect(message.event).toBe(target.kind === "http" ? "delivery-http-listening" : "delivery-worker-started");
      if (target.kind === "http") {
        const response = await fetch(message.url, { signal: AbortSignal.timeout(2000) });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("ready");
      }
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
      clearTimeout(deadline);
    }
  }
}, 25_000);

test("runtime copy permissions survive restrictive umask and existing private roots", async () => {
  const release = await storage.importRelease(input);
  const runtimeInput = {
    release, activationId: "01234567-89ab-4def-8123-456789abcdef", environmentId: "local",
    ports: { api: 31000 },
  };
  const runtimeRoot = join(root, "runtime");
  await mkdir(join(runtimeRoot, input.projectRef), { recursive: true, mode: 0o700 });
  const runtime = new ApplicationRuntimeFiles(storage, runtimeRoot);
  const oldMask = process.umask(0o077);
  let directory: string;
  try { directory = await runtime.prepare(runtimeInput, { api: {}, jobs: {} }); }
  finally { process.umask(oldMask); }
  for (const path of [runtimeRoot, join(runtimeRoot, input.projectRef), directory]) {
    expect((await lstat(path)).mode & 0o777).toBe(0o711);
  }
  const objectDirectory = join(directory, "objects", input.expectedObjects.api!);
  expect((await lstat(join(objectDirectory, "bundle"))).mode & 0o777).toBe(0o755);
  const entry = join(objectDirectory, "bundle/index.js");
  expect((await lstat(entry)).mode & 0o777).toBe(0o444);
  expect((await lstat(join(directory, "api.env"))).mode & 0o777).toBe(0o600);
  await chmod(entry, 0o400);
  await expect(runtime.prepare(runtimeInput, { api: {}, jobs: {} })).rejects.toThrow("UNREADABLE");
});

test("deployment composition starts real detached targets and recovers persisted traffic without replay", async () => {
  const release = await storage.importRelease(input);
  const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reserved.port!;
  await reserved.stop(true);
  const runtimeInput = {
    release, activationId: "81234567-89ab-4def-8123-456789abcdef", environmentId: "composed", ports: { api: port },
  };
  const plan = applicationRuntimePlan(runtimeInput);
  const runtimeRoot = join(root, "composed-runtime");
  const children = new Map<string, { child: ReturnType<typeof Bun.spawn>; message: string; invocation: string }>();
  let starts = 0, loads = 0;
  const runtime = new ApplicationSystemdRuntime({
    install: async (unit, content) => { assertManagedSystemdUnitContent(unit, content); },
    command: async args => {
      if (args[0] === "start") {
        starts++;
        for (const unit of args.slice(1)) {
          const target = plan.targets.find(target => target.unit === unit)!;
          const directory = join(runtimeRoot, plan.projectRef, plan.activationId, "objects", target.objectId);
          const child = Bun.spawn({
            cmd: [process.execPath, "--no-env-file", join(directory, "bundle/index.js")], cwd: directory,
            env: {
              PATH: process.env.PATH ?? "", HOST: "127.0.0.1", PORT: String(port), SHUTDOWN_TIMEOUT_MS: "2000",
              SUPACLOUD_PROJECT_REF: plan.projectRef, SUPACLOUD_APPLICATION_ID: plan.applicationId,
              SUPACLOUD_ENVIRONMENT_ID: plan.environmentId, SUPACLOUD_RELEASE_ID: plan.releaseId,
              SUPACLOUD_ACTIVATION_ID: plan.activationId, SUPACLOUD_TARGET: target.name, SUPACLOUD_OBJECT_ID: target.objectId,
            },
            stdout: "pipe", stderr: "ignore", stdin: "ignore",
          });
          const entry = { child, message: "", invocation: crypto.randomUUID().replaceAll("-", "") };
          children.set(unit, entry);
          const reader = child.stdout.getReader();
          try {
            while (!entry.message.includes("\n")) {
              const chunk = await reader.read();
              if (chunk.done) throw new Error("Composed host exited before startup");
              entry.message += new TextDecoder().decode(chunk.value);
              if (entry.message.length > 8192) throw new Error("Unexpected composed startup output");
            }
          } finally { reader.releaseLock(); }
          entry.message = entry.message.split("\n")[0]!;
        }
      } else if (args[0] === "stop") {
        for (const unit of args.slice(1)) {
          const entry = children.get(unit)!;
          if (entry.child.exitCode === null) entry.child.kill("SIGTERM");
          expect(await entry.child.exited).toBe(0);
        }
      } else if (args[0] === "show") {
        const entry = children.get(args[1]!)!;
        const running = entry.child.exitCode === null;
        return { exitCode: 0, stdout: `LoadState=loaded\nActiveState=${running ? "active" : "inactive"}\n`
          + `SubState=${running ? "running" : "dead"}\nMainPID=${running ? entry.child.pid : 0}\n`
          + `InvocationID=${entry.invocation}\nResult=success\n` };
      } else throw new Error("Unexpected supervisor operation");
      return { exitCode: 0, stdout: "" };
    },
  });
  const originalFetch = globalThis.fetch;
  const originalPath = config.caddyConfigPath;
  const originalState = config.caddyStateDir;
  let live: unknown;
  config.caddyConfigPath = join(root, "caddy/config.json");
  config.caddyStateDir = join(root, "caddy/state");
  globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
    const url = String(request);
    if (!url.startsWith(config.caddyAdminUrl)) return originalFetch(request, init);
    if (url.endsWith("/load")) { loads++; live = JSON.parse(String(init?.body)); return new Response("{}"); }
    if (url.endsWith("/config/")) return Response.json(live);
    if (url.endsWith("/routes")) {
      return Response.json((live as { apps: { http: { servers: { supacloud: { routes: unknown } } } } })
        .apps.http.servers.supacloud.routes);
    }
    return new Response("{}");
  }) as typeof fetch;
  const deadline = setTimeout(() => { for (const { child } of children.values()) child.kill("SIGKILL"); }, 25_000);
  try {
    const { journal } = activationJournal();
    journal.success = async () => { throw new Error("composed receipt lost"); };
    const migrations = await storage.readMigrations(input.projectRef, input.applicationId, release.release_id);
    const migration = migrations.archives[0]!.migrations[0]!;
    const dependencies = {
      storage, runtime, files: new ApplicationRuntimeFiles(storage, runtimeRoot), mutations: journal,
      active: new ApplicationActiveStorage(join(root, "composed-authority")),
      readiness: new ApplicationReadiness({
        observe: (input, signal) => runtime.inspect(input, signal),
        journal: async unit => {
          const entry = children.get(unit)!;
          return JSON.stringify({ _PID: String(entry.child.pid), _SYSTEMD_INVOCATION_ID: entry.invocation, MESSAGE: entry.message });
        },
      }),
      migrations: new ApplicationMigrations({
        storage, inventory: async () => [{
          version: migration.version, name: migration.name, statements: [migration.sql.trim()], statement_count: 1,
          applied_at: null,
          checksum: calculateMigrationChecksum({ version: migration.version, name: migration.name, statements: [migration.sql] }),
        }],
      }),
      verifyCompatibility: async () => {
        // This host fixture has no database dependency; the inventory above is
        // an adapter, not evidence for the production business workflow.
        expect(release.targets.map(target => target.kind).sort()).toEqual(["http", "worker"]);
      },
      gateway: new CaddyGatewayProvider(),
    };
    const deployment = {
      runtime: runtimeInput, environment: { api: {}, jobs: {} }, hosts: { api: ["composed.example.test"] },
      expectedActivationId: null, principal: { type: "project" as const, id: `project:${input.projectRef}` },
    };
    await expect(new ApplicationDeploymentService(dependencies).activate(deployment)).rejects.toThrow("composed receipt lost");
    expect(await (await originalFetch(`http://127.0.0.1:${port}`)).text()).toBe("ready");
    const restarted = new ApplicationDeploymentService({ ...dependencies, gateway: new CaddyGatewayProvider() });
    expect((await restarted.reconcile({
      projectRef: input.projectRef, applicationId: input.applicationId, environmentId: "composed",
      activationId: runtimeInput.activationId, principal: deployment.principal,
    })).replayed).toBe(true);
    expect((await restarted.activate(deployment)).replayed).toBe(true);
    expect(starts).toBe(1);
    expect(loads).toBe(1);
    expect((await dependencies.active.read(runtimeInput))?.hosts).toEqual(deployment.hosts);
    await runtime.stop(runtimeInput);
  } finally {
    for (const { child } of children.values()) child.kill("SIGKILL");
    await Promise.all([...children.values()].map(({ child }) => child.exited));
    clearTimeout(deadline);
    globalThis.fetch = originalFetch;
    config.caddyConfigPath = originalPath;
    config.caddyStateDir = originalState;
  }
}, 35_000);

test("managed detached hosts expose bound readiness and honor an application readiness failure", async () => {
  const release = await storage.importRelease(input);
  const runtimeInput = {
    release, activationId: "01234567-89ab-4def-8123-456789abcdef", environmentId: "local",
    ports: { api: 31000 },
  };
  const directory = await new ApplicationRuntimeFiles(storage, join(root, "runtime"))
    .prepare(runtimeInput, { api: {}, jobs: {} });
  const children: Array<ReturnType<typeof Bun.spawn>> = [];
  const messages: string[] = [];
  let httpUrl = "";
  const deadline = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, 20_000);
  try {
    for (const target of release.targets) {
      const child = Bun.spawn({
        cmd: [process.execPath, "--no-env-file", join(directory, "objects", target.object_id, target.entrypoint)],
        cwd: join(directory, "objects", target.object_id),
        env: {
          PATH: process.env.PATH ?? "", HOST: "127.0.0.1", PORT: "0", SHUTDOWN_TIMEOUT_MS: "2000",
          SUPACLOUD_PROJECT_REF: release.project_ref, SUPACLOUD_APPLICATION_ID: release.application_id,
          SUPACLOUD_ENVIRONMENT_ID: runtimeInput.environmentId, SUPACLOUD_RELEASE_ID: release.release_id,
          SUPACLOUD_ACTIVATION_ID: runtimeInput.activationId, SUPACLOUD_TARGET: target.name,
          SUPACLOUD_OBJECT_ID: target.object_id,
        },
        stdin: "ignore", stdout: "pipe", stderr: "ignore",
      });
      children.push(child);
      const reader = child.stdout.getReader();
      let text = "";
      try {
        while (!text.includes("\n")) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("Managed host did not announce readiness");
          text += new TextDecoder().decode(chunk.value);
          if (text.length > 8192) throw new Error("Unexpected startup output");
        }
      } finally { reader.releaseLock(); }
      const line = text.split("\n")[0]!;
      messages.push(line);
      const message = JSON.parse(line);
      if (target.kind === "http") {
        httpUrl = message.url;
        runtimeInput.ports.api = Number(new URL(httpUrl).port);
      } else {
        expect(message.identity.activation_id).toBe(runtimeInput.activationId);
        expect(message.identity.pid).toBe(child.pid);
      }
    }
    const readiness = new ApplicationReadiness({
      observe: async current => applicationRuntimePlan(current).targets.map((target, index) => ({
        target: target.name, unit: target.unit, mainPid: children[index]!.pid,
        invocationId: String(index + 1).repeat(32), result: "success",
        loadState: "loaded", activeState: "active", subState: "running",
        processRunning: children[index]!.exitCode === null,
      })),
      // Wrap actual child output in the journal envelope. Linux/journald
      // provenance still requires separate platform acceptance.
      journal: async unit => {
        const index = applicationRuntimePlan(runtimeInput).targets.findIndex(target => target.unit === unit);
        return JSON.stringify({
          _PID: String(children[index]!.pid), _SYSTEMD_INVOCATION_ID: String(index + 1).repeat(32),
          MESSAGE: messages[index],
        });
      },
    });
    const report = await readiness.requireReady(runtimeInput, 0);
    expect(report.ready).toBe(true);
    expect(report.targets.map(target => target.code)).toEqual(["READY", "READY"]);
    await fetch(new URL("/not-ready", httpUrl));
    const unhealthy = await readiness.inspect(runtimeInput);
    expect(unhealthy.ready).toBe(false);
    expect(unhealthy.targets.find(target => target.kind === "http")!.code).toBe("HTTP_NOT_READY");
  } finally {
    for (const child of children) child.kill("SIGTERM");
    await Promise.all(children.map(child => child.exited));
    clearTimeout(deadline);
  }
}, 30_000);
