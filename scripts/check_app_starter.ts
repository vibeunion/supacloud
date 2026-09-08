import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeAppProject } from "../packages/cli/src/shared/tools/app-starter";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "supacloud-starter-smoke-"));
const project = join(root, "project");
const environment: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && !/^(SUPACLOUD_|SUPABASE_|APP_ENV$|NODE_ENV$|PORT$)/.test(key)) {
    environment[key] = value;
  }
}

async function run(args: string[], cwd = project, success = true): Promise<string> {
  const child = Bun.spawn([process.execPath, "--no-env-file", ...args], {
    cwd, env: environment, stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 120_000);
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (success) assert.equal(status, 0, stdout + stderr);
    else assert.notEqual(status, 0, "Expected command to fail: " + args.join(" "));
    return stdout + stderr;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) { child.kill(); await child.exited; }
  }
}

let server: ReturnType<typeof Bun.spawn> | undefined;
try {
  await initializeAppProject({ root: project, name: "starter-smoke" });
  const manifestPath = join(project, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  // Test the release artifacts together before they exist on the public registry.
  for (const name of ["app", "compiler", "elysia"]) {
    const directory = join(repo, "packages", name);
    await run(["install", "--frozen-lockfile"], directory);
    await run(["run", "build"], directory);
    await run(["pm", "pack", "--destination", root], directory);
    const tarball = (await readdir(root)).find((file) => file.startsWith(`supacloud-${name}-`) && file.endsWith(".tgz"));
    assert.ok(tarball);
    const dependencies = name === "compiler" ? manifest.devDependencies : manifest.dependencies;
    dependencies[`@supacloud/${name}`] = `file:${join(root, tarball)}`;
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await run(["install", "--ignore-scripts"]);
  console.log("Starter: installed packed app/compiler/runtime and public third-party packages");
  console.log(await run(["run", "check"]));
  console.log(await run(["run", "build"]));

  // The production bundle must not contain the compiler or the memory demo entry.
  const bundle = await readFile(join(project, "dist/application.js"), "utf8");
  assert.ok(!bundle.includes("@typescript/typescript6"));
  assert.ok(!bundle.includes("Local demo:"));
  const artifact = join(project, "generated/application.ts");
  const original = await readFile(artifact, "utf8");
  const source = join(project, "src/review/review.ts");
  const validSource = await readFile(source, "utf8");
  const compiler = "node_modules/@supacloud/compiler/dist/cli.js";
  const context = JSON.parse(await run([compiler, "context", "review", "--json"]));
  assert.ok(context.executionPlans.some((plan: { stages: string[] }) => plan.stages.includes("authorize")));
  assert.ok(context.files.some((file: string) => file.endsWith("review.ts")));
  assert.ok(context.graphql.operations.some((operation: { name: string }) => operation.name === "ReviewList"));
  assert.ok(context.files.some((file: string) => file.endsWith("reviews.graphql")));

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
  console.log("Starter: context plans and JSON diagnostic/preview/write repair passed");

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
} finally {
  if (server?.exitCode === null) { server.kill("SIGTERM"); await server.exited; }
  await rm(root, { recursive: true, force: true });
}
