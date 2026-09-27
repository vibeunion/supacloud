import { strict as assert } from "node:assert";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeAppProject } from "../packages/cli/src/shared/tools/app-starter";
import type { CommandDatabase } from "../packages/db/src/command-adapter";
import { startStarterPostgres } from "./lib/starter-postgres";
import { startStarterLite } from "./lib/starter-lite";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function starterInstallArgs(profile: "workspace" | "consumer" | "locked-consumer"): string[] {
  return [
    "install", "--no-progress",
    profile === "locked-consumer" ? "--offline" : "--prefer-offline",
    ...(profile === "consumer" ? [] : ["--frozen-lockfile"]),
    ...(profile === "workspace" ? [] : ["--ignore-scripts"]),
  ];
}

export function addStarterTestDependencies(manifest: {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}): void {
  manifest.devDependencies.jose = "^6.2.11";
  // The generated command starter already declares this runtime dependency.
  manifest.dependencies["@supabase/supabase-js"] = "^2.115.0";
  delete manifest.devDependencies["@supabase/supabase-js"];
}

export async function runStarterCommand(
  args: string[],
  options: {
    cwd: string; env: Record<string, string>; signal: AbortSignal;
    success?: boolean; timeoutMs?: number;
  },
): Promise<string> {
  options.signal.throwIfAborted();
  const label = `${relative(repo, options.cwd)}: bun ${args.join(" ")}`;
  const started = performance.now();
  console.log(`Starter command: ${label}`);
  const child = Bun.spawn([process.execPath, "--no-env-file", ...args], {
    cwd: options.cwd, env: options.env, stdout: "pipe", stderr: "pipe",
  });
  let timedOut = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    escalation ??= setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 1_000);
  };
  const abort = () => stop();
  options.signal.addEventListener("abort", abort, { once: true });
  const timeoutMs = options.timeoutMs ?? 120_000;
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  try {
    if (options.signal.aborted) stop();
    const [status, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    options.signal.throwIfAborted();
    assert.ok(!timedOut, `Starter command timed out after ${timeoutMs}ms: ${label}\n${stdout}${stderr}`);
    if (options.success !== false) assert.equal(status, 0, `${label}\n${stdout}${stderr}`);
    else assert.notEqual(status, 0, `Expected command to fail: ${label}`);
    console.log(`Starter command completed: ${label} (${Math.round(performance.now() - started)}ms)`);
    return stdout + stderr;
  } finally {
    clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    options.signal.removeEventListener("abort", abort);
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
  }
}

export async function installStarterConsumer(
  cwd: string,
  run: (args: string[], cwd: string) => Promise<string>,
): Promise<void> {
  await run(starterInstallArgs("consumer"), cwd);
  // A second pass must use the selected graph without registry access or lock drift.
  await run(starterInstallArgs("locked-consumer"), cwd);
}

async function main(args: string[]) {
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--postgres-bin" || !args[1])) {
  throw new Error("Usage: check_app_starter.ts [--postgres-bin /path/to/postgresql/bin]");
}
const postgresBin = args[1];
const interruption = new AbortController();
let server: ReturnType<typeof Bun.spawn> | undefined;
const interrupt = () => {
  interruption.abort(new Error("Starter verification interrupted"));
  server?.kill("SIGTERM");
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const root = await mkdtemp(join(tmpdir(), "supacloud-starter-smoke-"));
let liteBackendStopped = true;
const project = join(root, "project");
const environment: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !/^(SUPACLOUD_|SUPABASE_|APP_ENV$|NODE_ENV$|PORT$)/.test(key)) {
    environment[key] = value;
  }
}

async function run(args: string[], cwd = project, success = true): Promise<string> {
  return runStarterCommand(args, { cwd, env: environment, signal: interruption.signal, success });
}

const tarballs = new Map<string, string>();
try {
  interruption.signal.throwIfAborted();
  await initializeAppProject({ root: project, name: "starter-smoke" });
  const manifestPath = join(project, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  // Test the release artifacts together before they exist on the public registry.
  manifest.overrides = { ...manifest.overrides };
  for (const name of ["contracts", "commands", "db", "app", "delivery", "compiler", "elysia", "js"]) {
    const directory = join(repo, "packages", name === "js" ? "supacloud-js" : name);
    await run(starterInstallArgs("workspace"), directory);
    await run(["run", "build"], directory);
    await run(["pm", "pack", "--destination", root], directory);
    const tarball = (await readdir(root)).find((file) => file.startsWith(`supacloud-${name}-`) && file.endsWith(".tgz"));
    assert.ok(tarball);
    const tarballPath = `file:${join(root, tarball)}`;
    tarballs.set(name, tarballPath);
    if (name === "compiler") {
      manifest.devDependencies[`@supacloud/${name}`] = tarballPath;
    } else if (Object.hasOwn(manifest.dependencies, `@supacloud/${name}`)) {
      manifest.dependencies[`@supacloud/${name}`] = tarballPath;
    }
    manifest.overrides[`@supacloud/${name}`] = tarballPath;
  }
  for (const name of ["contracts", "commands", "db", "js"]) {
    if (!Object.hasOwn(manifest.dependencies, `@supacloud/${name}`)) {
      manifest.devDependencies[`@supacloud/${name}`] = tarballs.get(name);
    }
  }
  addStarterTestDependencies(manifest);
  await copyFile(join(repo, "scripts/fixtures/starter-persistence.fixture"), join(project, "tests/persistence.ts"));
  await copyFile(join(repo, "scripts/fixtures/starter-attachments.fixture"), join(project, "tests/attachments.ts"));
  await copyFile(join(repo, "scripts/fixtures/starter-attachment-worker-delivery.fixture"), join(project, "tests/attachment-worker-delivery.ts"));
  await copyFile(join(repo, "scripts/fixtures/starter-review-delivery.fixture"), join(project, "tests/review-delivery.ts"));
  await copyFile(join(repo, "scripts/fixtures/starter-runtime-roles.fixture"), join(project, "tests/runtime-roles.ts"));
  await copyFile(join(repo, "scripts/fixtures/starter-delivery-archive.fixture"), join(project, "tests/delivery-archive.ts"));
  await copyFile(join(repo, "scripts/fixtures/starter-delivery-compatibility.fixture"), join(project, "tests/delivery-compatibility.ts"));
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await installStarterConsumer(project, run);
  await run(["-e", `import { bindCompiledCommand } from "@supacloud/elysia";
import { createDiagnosticRepairPlan } from "@supacloud/compiler";
if (typeof bindCompiledCommand !== "function" || typeof createDiagnosticRepairPlan !== "function") {
  throw new Error("Packed development-loop exports are missing");
}`]);
  console.log("Starter: installed packed app/compiler/runtime and public third-party packages");
  console.log(await run(["run", "check"]));
  console.log(await run(["run", "build"]));

  // Import the installed starter and exercise its compiled handler against the
  // actual Lite database bootstrap, not a memory implementation of PostgreSQL.
  const persistence: {
    verifyPersistentStarter(
      database: CommandDatabase & { exec(sql: string): Promise<void>; restart(): Promise<void> },
      verification?: { onExecution?(event: unknown): void; signal?: AbortSignal },
    ): Promise<Record<string, unknown>>;
  } = await import(join(project, "tests/persistence.ts"));
  const executionEvents: unknown[] = [];
  liteBackendStopped = false;
  const database = await startStarterLite(join(root, "persistent-review"), interruption.signal);
  try {
    const evidence = await persistence.verifyPersistentStarter(database, {
      signal: interruption.signal,
      onExecution(event) { executionEvents.push(event); },
    });
    console.log("Starter persistence: " + JSON.stringify({
      database: "lite-pglite", identity: "local-signed-fixture-not-live-SupAuth",
      fullPlatform: "not-run", ...evidence,
    }));
  } finally {
    await database.close();
    liteBackendStopped = true;
  }
  if (postgresBin) {
    const native = await startStarterPostgres(postgresBin, interruption.signal);
    try {
      // The queue SQL is Lite's compatibility implementation. This profile proves
      // native database concurrency, not the full platform or the pgmq extension.
      const sqlModules: { PGMQ_SQL: string } =
        await import(join(repo, "packages/supacloud-lite/src/runtime/db/emulated.ts"));
      await native.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
      await native.exec(sqlModules.PGMQ_SQL);
      for (const name of ["workflows-public", "commands-public"]) {
        await native.exec(await readFile(join(repo, `packages/management-api/src/db/sql-modules/${name}.sql`), "utf8"));
      }
      console.log("Starter persistence: " + JSON.stringify({
        database: "native-postgresql", queue: "lite-sql-compatibility",
        identity: "local-signed-fixture-not-live-SupAuth", fullPlatform: "not-run",
        ...await persistence.verifyPersistentStarter(native, { signal: interruption.signal }),
      }));
      const delivery: {
        verifyReviewDelivery(options: { database: CommandDatabase; databaseUrl: string; signal: AbortSignal }): Promise<unknown>;
      } = await import(join(project, "tests/review-delivery.ts"));
      const receipt = await native.withConnection(databaseUrl => delivery.verifyReviewDelivery({
        database: native, databaseUrl, signal: interruption.signal,
      }));
      console.log("Starter review delivery: " + JSON.stringify(receipt));
    } finally {
      await native.close();
    }
    liteBackendStopped = false;
    const nativeLite = await startStarterLite(join(root, "native-lite-review"), interruption.signal, postgresBin);
    try {
      console.log("Starter persistence: " + JSON.stringify({
        database: "lite-native-postgresql", queue: "lite-sql-compatibility",
        identity: "local-signed-fixture-not-live-SupAuth", fullPlatform: "not-run",
        ...await persistence.verifyPersistentStarter(nativeLite, { signal: interruption.signal }),
      }));
    } finally {
      await nativeLite.close();
      liteBackendStopped = true;
    }
  } else {
    console.log("Starter native PostgreSQL: not-run (provide --postgres-bin to use an isolated temporary cluster)");
  }

  // The production bundle must not contain the compiler or the memory demo entry.
  const bundle = await readFile(join(project, "dist/application.js"), "utf8");
  assert.ok(!bundle.includes("@typescript/typescript6"));
  assert.ok(!bundle.includes("Local demo:"));
  const artifact = join(project, "generated/application.ts");
  const original = await readFile(artifact, "utf8");
  const source = join(project, "src/review/review.ts");
  const validSource = await readFile(source, "utf8");
  const compiler = "node_modules/@supacloud/compiler/dist/cli.js";
  const observationFile = join(root, "execution-events.json");
  await writeFile(observationFile, JSON.stringify({ version: 1, events: executionEvents }));
  const feedbackArguments = [compiler, "context", "review", "--events", observationFile,
    "--request-id", "starter-permission-denied", "--json"];
  const feedback = JSON.parse(await run(feedbackArguments));
  assert.equal(feedback.subject, "review");
  assert.equal(feedback.deploymentVerified, false);
  assert.equal(feedback.eventsTrusted, false);
  assert.ok(feedback.events.some((event: { operation: string; stage: string; phase: string }) =>
    event.operation === "review.approve" && event.stage === "authorize" && event.phase === "failed"));
  assert.ok(feedback.events.every((event: { requestId: string }) => event.requestId === "starter-permission-denied"));
  assert.ok(!JSON.stringify(feedback).includes("starter-unrelated-failure"));
  assert.equal(feedback.omitted.unmatchedEvents, 0);
  assert.ok(feedback.events.some((event: { stage: string; phase: string }) =>
    event.stage === "commandExecutor" && event.phase === "failed"));
  const executorFeedback = JSON.parse(await run([compiler, "context", "review",
    "--events", observationFile, "--request-id", "starter-executor-failure", "--json"]));
  assert.equal(executorFeedback.omitted.unmatchedEvents, 0);
  assert.deepEqual(executorFeedback.events.map((event: { stage: string; phase: string }) => [event.stage, event.phase]),
    [["commandExecutor", "started"], ["commandExecutor", "failed"]]);
  const jobFeedback = JSON.parse(await run([compiler, "context", "review.verify-attachment",
    "--events", observationFile, "--request-id", "starter-attachment-job", "--json"]));
  assert.ok(jobFeedback.events.some((event: { kind: string; operation: string; stage: string; phase: string }) =>
    event.kind === "job" && event.operation === "review.verify-attachment" && event.stage === "handler" && event.phase === "failed"));
  assert.ok(jobFeedback.events.every((event: { requestId: string }) => event.requestId === "starter-attachment-job"));
  const context = JSON.parse(await run([compiler, "context", "review", "--json"]));
  assert.ok(context.executionPlans.some((plan: { stages: string[] }) => plan.stages.includes("authorize")));
  assert.ok(context.files.some((file: string) => file.endsWith("review.ts")));
  assert.ok(context.graphql.operations.some((operation: { name: string }) => operation.name === "ReviewList"));
  assert.ok(context.files.some((file: string) => file.endsWith("reviews.graphql")));
  for (const target of ["ApproveReview", "ReviewController"]) {
    const ownedContext = JSON.parse(await run([compiler, "context", target, "--json"]));
    assert.equal(ownedContext.subject, context.subject);
    assert.deepEqual(ownedContext, context, `Owned target ${target} must preserve module context`);
  }

  const query = join(project, "src/review/reviews.graphql");
  const validQuery = await readFile(query, "utf8");
  const queryArtifact = join(project, "generated/graphql.ts");
  const originalQueryArtifact = await readFile(queryArtifact, "utf8");
  await writeFile(query, validQuery.replace("id state version", "id missingField version"));
  const queryFailure = JSON.parse(await run([compiler, "compile", "--json"], project, false));
  assert.ok(queryFailure.diagnostics.some((item: { code: string }) => item.code === "graphql-validation"));
  assert.equal(await readFile(queryArtifact, "utf8"), originalQueryArtifact);
  await writeFile(query, validQuery.replace("id state version", "id version"));
  await run(["run", "check:generated"], project, false);
  await writeFile(query, validQuery);
  await run(["run", "check:generated"]);
  console.log("Starter: default GraphQL contracts, AI query context and artifact preservation passed");

  // Exercise the actual JSON diagnosis -> reviewed fix -> compile loop with a
  // configured src root, not only the programmatic repair API.
  await writeFile(source, validSource.replaceAll('transaction: "required"', 'transaction: "requried"'));
  const diagnosis = JSON.parse(await run([compiler, "check", "--json"], project, false));
  const modeFix = diagnosis.diagnostics.find((item: { code: string }) => item.code === "invalid-command-mode")?.fix;
  assert.ok(modeFix);
  const diagnosticContext = JSON.parse(await run(feedbackArguments));
  assert.ok(diagnosticContext.diagnostics.some((item: { code: string; repair?: { readiness: string } }) =>
    item.code === "invalid-command-mode" && item.repair?.readiness === "input-required"));
  assert.ok(diagnosticContext.events.some((event: { stage: string; phase: string }) =>
    event.stage === "authorize" && event.phase === "failed"));
  assert.ok(!JSON.stringify(diagnosticContext).includes("expectedExpression"));
  await writeFile(join(project, "fix.json"), JSON.stringify({ ...modeFix, value: "required" }));
  await run([compiler, "fix", "fix.json", "--dry-run"]);
  assert.ok((await readFile(source, "utf8")).includes('"requried"'));
  await run([compiler, "fix", "fix.json", "--write"]);
  // The feature specification also contains a policy literal. Restore it after
  // proving the command-scoped fix only changed the intended declaration.
  const fixed = await readFile(source, "utf8");
  assert.ok(fixed.includes('transaction: "required"'));
  await writeFile(source, validSource);
  await run([compiler, "compile"]);
  console.log("Starter: bounded runtime context, JSON diagnostic/preview/write repair and static plans passed");

  await writeFile(source, validSource.replace('to: "approved", command:', 'to: "missing", command:'));
  await run(["run", "compile"], project, false);
  assert.equal(await readFile(artifact, "utf8"), original, "Invalid compile replaced the working artifact");
  await writeFile(source, validSource);
  await writeFile(artifact, original + "\n// drift fixture\n");
  await run(["run", "check:generated"], project, false);
  await run(["run", "compile"]);

  // A generic .env must not poison the outer `bun run` process before the wrapper.
  await writeFile(join(project, ".env"), "APP_ENV=production\nSUPACLOUD_ENV=production\nCOMMON_ENV_SENTINEL=leaked\n");
  const inspected = await run(["run", "env:development", "bun", "--no-env-file", "-e",
    'console.log(JSON.stringify([process.env.APP_ENV, process.env.SUPACLOUD_ENV, process.env.COMMON_ENV_SENTINEL]))']);
  assert.ok(inspected.includes('["development","test",null]'), inspected);
  for (const target of ["staging", "production"]) {
    await run(["run", `env:${target}`, "bun", "scripts/serve.ts"], project, false);
  }

  server = Bun.spawn([process.execPath, "--no-env-file", "run", "dev"], {
    cwd: project, env: { ...environment, PORT: "0" }, stdout: "pipe", stderr: "pipe",
  });
  assert.ok(server.stdout && typeof server.stdout !== "number");
  const reader = server.stdout.getReader();
  let output = "";
  const timer = setTimeout(() => server?.kill(), 30_000);
  const errors = server.stderr && typeof server.stderr !== "number"
    ? new Response(server.stderr).text() : Promise.resolve("");
  let origin: string | undefined;
  try {
    while (!origin) {
      const { done, value } = await reader.read();
      if (done) throw new Error("Dev server exited before readiness: " + output + await errors);
      output += new TextDecoder().decode(value);
      origin = output.match(/Local demo: (http:\/\/127\.0\.0\.1:\d+\/)/)?.[1];
    }
    assert.equal((await fetch(origin + "reviews/health")).status, 200);
    const approved = await fetch(origin + "reviews/demo/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "http-smoke" },
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    assert.equal(approved.status, 200);
    assert.deepEqual(await approved.json(), { state: "approved", version: 2 });

    await writeFile(source, validSource.replace("ok: true", "ok: false"));
    output = "";
    let restarted: string | undefined;
    while (!restarted) {
      const { done, value } = await reader.read();
      if (done) throw new Error("Dev server exited during restart");
      output += new TextDecoder().decode(value);
      restarted = output.match(/Local demo: (http:\/\/127\.0\.0\.1:\d+\/)/)?.[1];
    }
    assert.deepEqual(await (await fetch(restarted + "reviews/health")).json(), { ok: false });
    console.log("Starter: HTTP, command governance, env isolation, drift gates and watch/restart passed");
  } finally {
    clearTimeout(timer);
    server.kill("SIGTERM");
    await server.exited;
    reader.releaseLock();
    await errors;
  }

  // Prove the non-default golden-path templates with the same packed artifacts
  // in one packing pass, so every supported path stays smoke-covered.
  for (const template of ["http", "edge"] as const) {
    const templateProject = join(root, `${template}-project`);
    await initializeAppProject({ root: templateProject, name: `${template}-smoke`, template });
    const templateManifestPath = join(templateProject, "package.json");
    const templateManifest = JSON.parse(await readFile(templateManifestPath, "utf8"));
    templateManifest.overrides = { ...templateManifest.overrides };
    for (const [name, tarballPath] of tarballs) {
      if (name === "compiler") templateManifest.devDependencies[`@supacloud/${name}`] = tarballPath;
      else if (name === "app" || name === "elysia") templateManifest.dependencies[`@supacloud/${name}`] = tarballPath;
      templateManifest.overrides[`@supacloud/${name}`] = tarballPath;
    }
    await writeFile(templateManifestPath, JSON.stringify(templateManifest, null, 2));
    await installStarterConsumer(templateProject, run);
    console.log(await run(["run", "check"], templateProject));
    console.log(await run(["run", "test"], templateProject));
    console.log(await run(["run", "build"], templateProject));

    const templateBundle = await readFile(join(templateProject, "dist/application.js"), "utf8");
    assert.ok(!templateBundle.includes("@typescript/typescript6"), "Template bundle must not contain the compiler");
    assert.ok(!templateBundle.includes("Local demo:"), "Template bundle must not contain the memory demo server");

    const target = template === "http" ? "orders" : "sync";
    const feature = template === "http" ? "orders.ts" : "sync.ts";
    const templateContext = JSON.parse(await run([
      "node_modules/@supacloud/compiler/dist/cli.js", "context", target, "--json",
    ], templateProject));
    assert.ok(templateContext.files.some((file: string) => file.endsWith(feature)));
    console.log(`Starter ${template}: packed check/test/build, bundle boundary and AI context passed`);
    if (template === "http") {
      await copyFile(join(repo, "scripts/fixtures/starter-http-delivery.fixture"), join(templateProject, "scripts/verify-http-delivery.ts"));
      console.log(await run(["scripts/verify-http-delivery.ts"], templateProject));
    } else {
      await copyFile(join(repo, "scripts/fixtures/starter-worker-delivery.fixture"), join(templateProject, "scripts/verify-worker-delivery.ts"));
      console.log(await run(["scripts/verify-worker-delivery.ts"], templateProject));
    }
  }
} finally {
  try {
    if (server?.exitCode === null) { server.kill("SIGTERM"); await server.exited; }
    if (liteBackendStopped) await rm(root, { recursive: true, force: true });
    else console.error(`Starter cleanup not confirmed; retained fixture directory: ${root}`);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
}

if (import.meta.main) await main(process.argv.slice(2));
