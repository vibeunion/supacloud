import { strict as assert } from "node:assert";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { runStarterCommand, starterInstallArgs } from "./check_app_starter";
import { startStarterLite, type StarterLite } from "./lib/starter-lite";

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "Expected a manifest object");
  return value as Record<string, unknown>;
}
export function exactPublishedVersion(value: string | undefined): string {
  if (!value || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z0-9.-]+)?$/.test(value)) {
    throw new Error("An exact published version is required; tags, paths and ranges are not accepted");
  }
  return value;
}
export function assertRegistryManifest(value: unknown): void {
  const manifest = record(value);
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides", "resolutions"]) {
    if (manifest[field] === undefined) continue;
    for (const version of Object.values(record(manifest[field]))) {
      if (typeof version !== "string" || !/^[~^<>=0-9*]/.test(version)
        || /(?:file:|link:|workspace:|https?:|git|\/|\\)/.test(version)) {
        throw new Error("Published consumer cannot contain local, URL or workspace dependency overrides");
      }
    }
  }
}
export function assertPublishedPackageManifest(value: unknown, expectedName: string, expectedVersion?: string): string {
  const manifest = record(value);
  assert.equal(manifest["name"], expectedName, `Installed package name must be ${expectedName}`);
  const version = manifest["version"];
  assert.ok(typeof version === "string" && exactPublishedVersion(version), `Installed ${expectedName} version must be exact`);
  if (expectedVersion !== undefined) assert.equal(version, expectedVersion, `${expectedName} version must match the requested version`);
  return version;
}

// Preserve transport settings required by proxied registries without inheriting
// application credentials, package overrides, or insecure TLS bypass flags.
export function publishedConsumerEnvironment(source: NodeJS.ProcessEnv, home: string): Record<string, string> {
  const transport = Object.fromEntries([
    "PATH", "TMPDIR", "SYSTEMROOT",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "no_proxy", "all_proxy",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
  ].flatMap(key => source[key] === undefined ? [] : [[key, source[key]!]]));
  return { ...transport, HOME: home, USERPROFILE: home };
}

/** Replace old reports without retaining permissive modes or following a destination symlink. */
export async function writePrivateAcceptanceFile(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = await mkdtemp(join(dirname(file), ".supacloud-acceptance-"));
  try {
    const staged = join(temporary, "report");
    await writeFile(staged, content, { mode: 0o600, flag: "wx" });
    await rename(staged, file);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Normalize filesystem aliases without allowing package symlinks to escape the consumer install. */
export async function assertInstalledPackagePath(path: string, nodeModules: string, label: string): Promise<void> {
  const [resolvedPath, resolvedNodeModules] = await Promise.all([realpath(path), realpath(nodeModules)]);
  const installedPath = relative(resolvedNodeModules, resolvedPath);
  assert.ok(installedPath !== "" && !isAbsolute(installedPath)
    && installedPath !== ".." && !installedPath.startsWith(".." + sep),
    `${label} must be an installed package`);
}

/** Runs against the supplied consumer only; no templates or runtime modules are substituted. */
export async function verifyPublishedExecutionContext(
  project: string,
  cli: string,
  run: (args: string[], success?: boolean) => Promise<string>,
): Promise<void> {
  const preserved = ["src/host/review-execution-observability.ts", "src/host/review-worker-observability.ts",
    "src/review/review.ts", "src/review/attachment.ts", "generated/application.ts"];
  const before = await Promise.all(preserved.map(file => readFile(join(project, file), "utf8")));
  const temporary = await mkdtemp(join(tmpdir(), "published-execution-context-"));
  try {
    // Synthetic observations test the installed logging/context contract, not business execution.
    const output = await run(["--eval", `
const { createReviewHttpObserver } = await import("./src/host/review-execution-observability.ts");
const { createReviewWorkerObserver } = await import("./src/host/review-worker-observability.ts");
const observe = createReviewHttpObserver();
for (const requestId of ["published-context-request", "unrelated-context-request"]) {
  observe({ kind: "command", operation: "review.approve", stage: "authorize", phase: "failed", requestId, durationMs: 1 });
}
const observeWorker = createReviewWorkerObserver("published-context-worker");
for (const phase of ["started", "failed"]) {
  observeWorker({ kind: "job", operation: "review.verify-attachment", stage: "handler",
    phase, requestId: "published-context-run", durationMs: 2 });
}
observeWorker({ kind: "job", operation: "review.verify-attachment", stage: "handler",
  phase: "succeeded", requestId: "unrelated-context-run", durationMs: 3 });
`]);
    const lines = output.trim().split(/\r?\n/);
    assert.equal(lines.length, 5, "Published observers must emit exactly five execution records");
    for (const [index, line] of lines.entries()) {
      const log = record(JSON.parse(line));
      const worker = index >= 2;
      assert.equal(log["event"], worker ? "review-worker-execution" : "review-http-execution");
      assert.equal(log["component"], worker ? "review-attachment-worker" : "review-http");
      assert.equal(log["workerId"], worker ? "published-context-worker" : undefined);
    }
    const events = join(temporary, "execution.ndjson");
    await writeFile(events, output, { mode: 0o600 });
    for (const [command, requestFlag] of [
      [["app", "context"], "--request-id"], [["context"], "--request_id"],
    ] as const) {
      const args = [cli, ...command, "--root", project, "--target", "review",
        "--events", events, requestFlag, "published-context-request", "--format", "json"];
      const response = await run(args);
      const pack = record(JSON.parse(response));
      const execution = record(pack["execution"]), workflow = record(pack["workflow"]);
      assert.equal(pack["subject"], "review");
      assert.equal(workflow["executed"], false);
      assert.equal(execution["correlation"], "current-graph-only");
      assert.equal(execution["eventsTrusted"], false);
      assert.equal(execution["deploymentVerified"], false);
      assert.deepEqual(execution["events"], [{
        kind: "command", operation: "review.approve", stage: "authorize", phase: "failed",
        requestId: "published-context-request", durationMs: 1, index: 0, module: "review",
      }]);
      assert.ok(!response.includes("unrelated-context-request"));
      assert.ok(!response.includes("published-context-run"));
      assert.ok(!response.includes("unrelated-context-run"));
      const denied = await run([...args, "--write"], false);
      assert.ok(denied.includes("--write is not supported"));

      const workerResponse = await run([cli, ...command, "--root", project, "--target", "review",
        "--events", events, requestFlag, "published-context-run", "--format", "json"]);
      const workerPack = record(JSON.parse(workerResponse));
      const workerExecution = record(workerPack["execution"]);
      assert.equal(record(workerPack["workflow"])["executed"], false);
      assert.equal(workerExecution["correlation"], "current-graph-only");
      assert.equal(workerExecution["eventsTrusted"], false);
      assert.equal(workerExecution["deploymentVerified"], false);
      assert.deepEqual(workerExecution["events"], ["started", "failed"].map((phase, index) => ({
        kind: "job", operation: "review.verify-attachment", stage: "handler", phase,
        requestId: "published-context-run", durationMs: 2, index: index + 2, module: "review",
      })));
      const timeline = workerExecution["timeline"];
      assert.ok(Array.isArray(timeline) && timeline.length === 1);
      const job = record(timeline[0]);
      assert.equal(job["kind"], "job");
      assert.equal(job["operation"], "review.verify-attachment");
      const attempts = job["attempts"];
      assert.ok(Array.isArray(attempts) && attempts.length === 1);
      const attempt = record(attempts[0]);
      assert.equal(attempt["failed"], true);
      assert.equal(attempt["complete"], false);
      assert.deepEqual(attempt["traceIds"], []);
      assert.deepEqual(attempt["stages"], ["started", "failed"].map((phase, index) => ({
        stage: "handler", phase, durationMs: 2, index: index + 2,
      })));
      for (const unrelated of ["published-context-request", "unrelated-context-request", "unrelated-context-run"]) {
        assert.ok(!workerResponse.includes(unrelated));
      }
    }
    await writeFile(events, lines[0] + '\n{"event":"PRIVATE_EXECUTION_INPUT"}\n');
    const denied = await run([cli, "app", "context", "--root", project, "--target", "review",
      "--events", events, "--request-id", "published-context-request", "--format", "json"], false);
    assert.ok(denied.includes("EXECUTION_METADATA_INVALID"));
    assert.ok(!denied.includes("PRIVATE_EXECUTION_INPUT"));
    const invalidWorker = { ...record(JSON.parse(lines[2]!)), payload: "PRIVATE_WORKER_INPUT" };
    await writeFile(events, lines[0] + "\n" + JSON.stringify(invalidWorker) + "\n");
    const workerDenied = await run([cli, "context", "--root", project, "--target", "review",
      "--events", events, "--request_id", "published-context-run", "--format", "json"], false);
    assert.ok(workerDenied.includes("EXECUTION_METADATA_INVALID"));
    assert.ok(!workerDenied.includes("PRIVATE_WORKER_INPUT"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
    const after = await Promise.all(preserved.map(file => readFile(join(project, file), "utf8")));
    assert.deepEqual(after, before, "Execution context must not rewrite source or generated artifacts");
  }
}

async function main(args: string[]) {
  const { values } = parseArgs({ args, strict: true, options: {
    "cli-version": { type: "string" }, "lite-version": { type: "string" },
    "postgres-bin": { type: "string" }, report: { type: "string" },
  } });
  const cliVersion = exactPublishedVersion(values["cli-version"]);
  const liteVersion = exactPublishedVersion(values["lite-version"]);
  if (!values.report) throw new Error("--report is required");
  const reportFile = resolve(values.report);
  const root = await mkdtemp(join(tmpdir(), "supacloud-published-customer-"));
  const tools = join(root, "tools"), project = join(root, "application");
  const isolatedHome = join(root, "home");
  const signal = new AbortController();
  const interrupt = () => signal.abort(new Error("Published customer acceptance interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const env = publishedConsumerEnvironment(process.env, isolatedHome);
  const report: {
    schema: string; status: "incomplete" | "failed" | "passed"; stage: string;
    versions: Record<string, string>; checks: string[];
    runtime: string; identity: string; livePlatformAcceptance: false; workspaceOverrides: false;
    databaseEvidence?: unknown; failure?: string;
  } = {
    schema: "supacloud.published-customer-acceptance.v1", status: "incomplete", stage: "install-cli",
    versions: { "@supacloud/cli": cliVersion, "@supacloud/lite": liteVersion }, checks: [],
    runtime: values["postgres-bin"] ? "native-postgresql" : "pglite",
    identity: "local-signed-fixture-not-live-SupAuth", livePlatformAcceptance: false, workspaceOverrides: false,
  };
  let backend: StarterLite | undefined;
  const run = (args: string[], cwd = project) => runStarterCommand(args, { cwd, env, signal: signal.signal });
  try {
    await mkdir(tools);
    await mkdir(isolatedHome);
    await writeFile(join(tools, "package.json"), JSON.stringify({
      private: true, type: "module", dependencies: { "@supacloud/cli": cliVersion },
    }));
    await run(starterInstallArgs("consumer"), tools);
    const cliManifest = record(JSON.parse(await readFile(join(tools, "node_modules/@supacloud/cli/package.json"), "utf8")));
    assertPublishedPackageManifest(cliManifest, "@supacloud/cli", cliVersion);
    const bin = record(cliManifest["bin"]);
    const entry = bin["supacloud"];
    assert.ok(typeof entry === "string" && /^dist\/[A-Za-z0-9._/-]+$/.test(entry) && !entry.includes(".."));
    report.stage = "generate";
    await run([join(tools, "node_modules/@supacloud/cli", entry), "app", "init",
      "--root", project, "--name", "published-reference", "--template", "command"], tools);
    report.checks.push("installed-cli-generation");
    const manifestFile = join(project, "package.json");
    const manifest = record(JSON.parse(await readFile(manifestFile, "utf8")));
    assertRegistryManifest(manifest);
    const dev = record(manifest["devDependencies"]);
    dev["@supacloud/lite"] = liteVersion;
    dev["jose"] = "6.2.12";
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
    report.stage = "install-consumer";
    await run(starterInstallArgs("consumer"));
    await run(starterInstallArgs("locked-consumer"));
    for (const name of ["app", "compiler", "elysia", "commands", "contracts", "db", "js", "lite"]) {
      const installed: unknown = JSON.parse(await readFile(join(project, `node_modules/@supacloud/${name}/package.json`), "utf8"));
      report.versions[`@supacloud/${name}`] = assertPublishedPackageManifest(
        installed, `@supacloud/${name}`, name === "lite" ? liteVersion : undefined);
    }
    report.checks.push("registry-install", "frozen-offline-install");
    report.stage = "compile";
    await run(["run", "db:generate"]);
    await run(["run", "compile"]);
    await run(["run", "check:generated"]);
    await run(["run", "typecheck"]);
    report.checks.push("generated-contracts", "consumer-types");
    report.stage = "execution-context";
    const cliCompiler = Bun.resolveSync("@supacloud/compiler", join(tools, "node_modules/@supacloud/cli"));
    await assertInstalledPackagePath(cliCompiler, join(tools, "node_modules"), "CLI compiler");
    const cliCompilerManifest = record(JSON.parse(await readFile(join(dirname(cliCompiler), "../package.json"), "utf8")));
    report.versions["cli:@supacloud/compiler"] = assertPublishedPackageManifest(cliCompilerManifest, "@supacloud/compiler");
    await verifyPublishedExecutionContext(project, join(tools, "node_modules/@supacloud/cli", entry),
      (args, success = true) => runStarterCommand(args, { cwd: project, env, signal: signal.signal, success }));
    report.checks.push("published-execution-observer", "published-app-context", "published-context-alias",
      "execution-context-read-only", "execution-context-invalid-input-denied",
      "published-worker-execution-observer", "execution-context-worker-timeline",
      "execution-context-identity-isolation", "execution-context-worker-invalid-input-denied");
    report.stage = "client-states";
    // Missing published client examples fail; never inject workspace replacements.
    await readFile(join(project, "tests/review-client.test.ts"));
    await run(["test", "tests/review-client.test.ts"]);
    report.checks.push("published-client-states");
    report.stage = "durable-business";
    for (const name of ["persistence", "attachments", "attachment-worker-delivery",
      "review-delivery", "runtime-roles", "delivery-archive", "delivery-compatibility"]) {
      await copyFile(new URL(`./fixtures/starter-${name}.fixture`, import.meta.url), join(project, "tests", `${name}.ts`));
    }
    const fixture: {
      verifyPersistentStarter(database: StarterLite, options: { signal: AbortSignal; verifyReceipts: boolean }): Promise<unknown>;
    } = await import(join(project, "tests/persistence.ts"));
    const publicLite = Bun.resolveSync("@supacloud/lite", project);
    await assertInstalledPackagePath(publicLite, join(project, "node_modules"), "Runtime");
    backend = await startStarterLite(join(root, "database"), signal.signal, values["postgres-bin"], publicLite);
    report.databaseEvidence = await fixture.verifyPersistentStarter(backend, { signal: signal.signal, verifyReceipts: true });
    report.checks.push("durable-approval", "restart-and-replay", "permissions", "attachments-and-worker", "read-only-receipt-recovery");
    report.stage = "complete";
    report.status = "passed";
  } catch (error) {
    // Keep detailed local diagnostics private and out of the portable receipt.
    const diagnosticFile = reportFile + ".diagnostic.txt";
    await writePrivateAcceptanceFile(diagnosticFile, error instanceof Error ? error.stack ?? error.message : "Unknown failure");
    report.status = "failed";
    report.failure = `Acceptance failed at ${report.stage}; inspect the adjacent private .diagnostic.txt file. No deployment was attempted.`;
    process.exitCode = 1;
  } finally {
    try {
      await backend?.close();
      await rm(root, { recursive: true, force: true });
    } catch {
      report.status = "failed";
      report.failure = "Disposable consumer cleanup was not confirmed.";
      process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      await writePrivateAcceptanceFile(reportFile, JSON.stringify(report, null, 2) + "\n");
      console.log(JSON.stringify(report));
    }
  }
}

if (import.meta.main) await main(process.argv.slice(2));
