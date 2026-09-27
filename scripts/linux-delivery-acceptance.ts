import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readDeliveryExecutableArchive } from "../packages/delivery/src";
import { config } from "../packages/management-api/src/config";
import { ApplicationReleaseStorage } from "../packages/management-api/src/services/application-release-storage";
import { ApplicationRuntimeFiles } from "../packages/management-api/src/services/application-runtime-files";
import { ApplicationSystemdRuntime, applicationRuntimePlan } from "../packages/management-api/src/services/application-runtime";
import { ApplicationReadiness } from "../packages/management-api/src/services/application-readiness";
import { CaddyGatewayProvider } from "../packages/management-api/src/services/gateway.service";
import { removeManagedSystemdUnit } from "../packages/management-api/src/services/systemd-unit-broker";

// This runner owns ports 80/443/2019 and requires a disposable, dedicated machine.
assert.equal(process.platform, "linux");
assert.equal(process.getuid?.(), 0);
assert.equal(process.env.SUPACLOUD_LINUX_ACCEPTANCE, "1");
assert.equal(Bun.version, "1.4.2");
assert.equal(config.caddyTlsIssuer, "internal");
const build = JSON.parse(await readFile(join(import.meta.dir, "acceptance-build.json"), "utf8"));
assert.equal(build.schema, "supacloud.linux-delivery-build.v1");
for (const [name, digest] of Object.entries(build.files)) {
  assert.equal(createHash("sha256").update(await readFile(join(import.meta.dir, name))).digest("hex"), digest);
}
const sockets: { stop(closeActiveConnections?: boolean): void }[] = [];
try {
  for (const port of [80, 443, 2019]) {
    sockets.push(Bun.listen({ hostname: "::", port, socket: { data() {} } }));
  }
} finally {
  for (const socket of sockets) socket.stop(true);
}
await mkdir("/var/lib/supacloud-delivery-acceptance", { recursive: true });
const root = await mkdtemp("/var/lib/supacloud-delivery-acceptance/run-");
config.caddyConfigPath = join(root, "caddy/config.json");
config.caddyStateDir = join(root, "caddy/state");
config.caddyAdminUrl = "http://127.0.0.1:2019";
const manifestPath = resolve(process.argv[2] ?? join(import.meta.dir, "archive/delivery.manifest.json"));
const archive = await readDeliveryExecutableArchive(manifestPath);
const storage = new ApplicationReleaseStorage(join(root, "releases"));
const release = await storage.importRelease({
  projectRef: "delivery-linux", applicationId: "acceptance", manifestPath,
  expectedObjects: Object.fromEntries(archive.objects.map(({ object }) => [object.name, object.objectId])),
});
const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = reserve.port!;
await reserve.stop(true);
const input = {
  release, activationId: crypto.randomUUID(), environmentId: "acceptance", ports: { api: port },
};
const plan = applicationRuntimePlan(input);
const runtime = new ApplicationSystemdRuntime();
const readiness = new ApplicationReadiness();
const route = { runtime: input, hosts: { api: ["delivery.example.test"] } };
const bootstrap = join(root, "bootstrap.json");
await writeFile(bootstrap, JSON.stringify({ admin: { listen: "127.0.0.1:2019" } }));
const cancellation = new AbortController();
let caddy: ReturnType<typeof Bun.spawn> | undefined;
const interrupt = () => {
  cancellation.abort(new Error("Linux acceptance interrupted"));
  // Close the owned server's sockets even when /load hangs; do not leave a
  // Promise.race loser applying effects while systemd cleanup is running.
  if (caddy?.exitCode === null) caddy.kill("SIGKILL");
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
// Finish each in-flight effect before cleanup; never race a systemctl start with stop.
async function step<T>(operation: () => Promise<T>): Promise<T> {
  cancellation.signal.throwIfAborted();
  const result = await operation();
  cancellation.signal.throwIfAborted();
  return result;
}
const evidence: Record<string, unknown> = {
  schema: "supacloud.linux-delivery-acceptance.v1", root,
  bun: Bun.version, releaseId: release.release_id, activationId: input.activationId,
  scope: "real-systemd-journald-caddy; no business database or activation journal",
  build,
};
let failure: unknown;
try {
  caddy = Bun.spawn({
    cmd: [config.caddyBinaryPath, "run", "--config", bootstrap],
    stdout: Bun.file(join(root, "caddy.stdout.log")), stderr: Bun.file(join(root, "caddy.stderr.log")),
  });
  let connected = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    cancellation.signal.throwIfAborted();
    assert.equal(caddy.exitCode, null, "Owned Caddy exited before startup");
    try {
      const response = await fetch(`${config.caddyAdminUrl}/config/`, { signal: AbortSignal.timeout(1000) });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), JSON.parse(await readFile(bootstrap, "utf8")));
      connected = true;
      break;
    } catch (error) {
      if (attempt === 49) throw error;
      await Bun.sleep(100);
    }
  }
  assert.ok(connected);
  await step(() => new ApplicationRuntimeFiles(storage).prepare(input, { api: {}, jobs: {} }));
  await step(() => runtime.install(input));
  await step(() => runtime.start(input));
  const ready = await step(() => readiness.requireReady(input));
  assert.equal(ready.ready, true);
  for (const target of ready.targets) {
    assert.ok(target.pid > 0);
    assert.match(target.invocation_id!, /^[a-f0-9]{32}$/);
    const status = await readFile(`/proc/${target.pid}/status`, "utf8");
    for (const [property, option] of [["Uid", "-u"], ["Gid", "-g"]]) {
      const identity = Bun.spawn(["id", option!, "supacloud-delivery-linux"], { stdout: "pipe", stderr: "pipe" });
      const expected = (await new Response(identity.stdout).text()).trim();
      assert.equal(await identity.exited, 0);
      assert.notEqual(expected, "0");
      assert.deepEqual(new RegExp(`^${property}:\\s+(.+)$`, "m").exec(status)?.[1]?.trim().split(/\s+/),
        [expected, expected, expected, expected], "Runtime must use the exact tenant identity");
    }
  }
  evidence.initialReadiness = ready;
  const provider = new CaddyGatewayProvider();
  assert.equal(caddy.exitCode, null);
  assert.equal((await step(() => provider.ensureGatewayReady({ maxAttempts: 10, intervalMs: 200 }))).ready, true);
  await step(() => provider.configureApplicationRoute(route));
  await step(() => provider.verifyApplicationRoute(route));
  const response = await fetch("http://127.0.0.1/", {
    headers: { host: "delivery.example.test" }, redirect: "manual", signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "linux-delivery-ready");
  evidence.httpThroughCaddy = true;
  await step(() => new CaddyGatewayProvider().verifyApplicationRoute(route));
  evidence.providerRestartReadback = true;

  // Real supervisor restart must produce fresh PIDs and journal invocation identities.
  await step(() => runtime.stop(input));
  assert.equal((await step(() => readiness.inspect(input))).ready, false);
  await step(() => runtime.start(input));
  const restarted = await step(() => readiness.requireReady(input));
  for (const target of restarted.targets) {
    const previous = ready.targets.find(item => item.target === target.target)!;
    assert.notEqual(target.invocation_id, previous.invocation_id);
  }
  evidence.restartedReadiness = restarted;
  await fetch(`http://127.0.0.1:${port}/not-ready`, { signal: AbortSignal.timeout(5000) });
  const unhealthy = await step(() => readiness.inspect(input));
  assert.equal(unhealthy.ready, false);
  assert.equal(unhealthy.targets.find(target => target.kind === "http")?.code, "HTTP_NOT_READY");
  assert.equal(unhealthy.targets.find(target => target.kind === "worker")?.ready, true);
  evidence.unhealthyReadiness = unhealthy;
  assert.equal(caddy.exitCode, null, "Owned Caddy exited during acceptance");
  cancellation.signal.throwIfAborted();
} catch (error) {
  failure = error;
} finally {
  const cleanup: string[] = [];
  try {
    const stopped = await runtime.stop(input);
    assert.ok(stopped.every(target => target.mainPid === 0));
    evidence.stopped = stopped;
  } catch (error) { cleanup.push(String(error)); }
  for (const target of plan.targets) {
    try { await removeManagedSystemdUnit(target.unit); }
    catch (error) { cleanup.push(String(error)); }
  }
  if (caddy) {
    if (caddy.exitCode === null) caddy.kill("SIGTERM");
    const timeout = setTimeout(() => caddy?.kill("SIGKILL"), 5000);
    await caddy.exited;
    clearTimeout(timeout);
  }
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  if (cleanup.length) failure = new AggregateError([failure, ...cleanup], "Linux acceptance cleanup failed");
  if (cancellation.signal.aborted) failure ??= cancellation.signal.reason;
  evidence.status = failure ? "FAIL" : "PASS";
  if (failure) evidence.error = String(failure);
  await writeFile(join(root, "receipt.json"), JSON.stringify(evidence, null, 2));
  const { build: _build, ...summary } = evidence;
  console.log(JSON.stringify(summary, null, 2));
}
if (failure) throw failure;
