import { strict as assert } from "node:assert";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

// Preserve transport settings required by proxied registries without inheriting
// application credentials, package overrides, or insecure TLS bypass flags.
export function publishedConsumerEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries([
    "PATH", "HOME", "TMPDIR", "SYSTEMROOT",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "no_proxy", "all_proxy",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
  ].flatMap(key => source[key] === undefined ? [] : [[key, source[key]!]]));
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
  const signal = new AbortController();
  const interrupt = () => signal.abort(new Error("Published customer acceptance interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const env = publishedConsumerEnvironment(process.env);
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
    await writeFile(join(tools, "package.json"), JSON.stringify({
      private: true, type: "module", dependencies: { "@supacloud/cli": cliVersion },
    }));
    await run(starterInstallArgs("consumer"), tools);
    const cliManifest = record(JSON.parse(await readFile(join(tools, "node_modules/@supacloud/cli/package.json"), "utf8")));
    assert.equal(cliManifest["version"], cliVersion);
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
      const installed = record(JSON.parse(await readFile(join(project, `node_modules/@supacloud/${name}/package.json`), "utf8")));
      assert.ok(typeof installed["version"] === "string");
      report.versions[`@supacloud/${name}`] = installed["version"];
    }
    report.checks.push("registry-install", "frozen-offline-install");
    report.stage = "compile";
    await run(["run", "db:generate"]);
    await run(["run", "compile"]);
    await run(["run", "check:generated"]);
    await run(["run", "typecheck"]);
    report.checks.push("generated-contracts", "consumer-types");
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
    assert.ok(publicLite.startsWith(join(project, "node_modules") + "/"), "Runtime must be an installed package");
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
