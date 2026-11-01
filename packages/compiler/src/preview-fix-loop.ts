import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { applicationPreviewBranchRef } from "@supacloud/delivery";
import { analyzeProject } from "./analyze";
import { compileProject } from "./compile";
import { createExecutionContextPack, readExecutionMetadata } from "./execution-context";
import { applyDiagnosticFix } from "./fixes";
import type { Diagnostic, DiagnosticFix } from "./types";

/** Recorded preview evidence. This file is not a live deploy and not an npm publish. */
export const PREVIEW_DEPLOY_RECEIPT_SCHEMA = "supacloud.preview-deploy-receipt.v1";

const PREVIEW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECT_REF = /^[a-z0-9-]{1,20}$/;
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RELATIVE_FILE = /^(?!\/)(?!\.\.(?:\/|$))(?!.*\/\.\.(?:\/|$))[A-Za-z0-9_./-]{1,240}$/;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 1_048_576;
const EVENTS_FILE = "preview-execution-events.json";
const RECEIPT_FILE = "preview-deploy-receipt.json";

export type PreviewFixErrorCode =
  | "PREVIEW_FIX_ROOT_UNSUPPORTED"
  | "PREVIEW_FIX_IDENTITY_MISMATCH"
  | "PREVIEW_FIX_POLICY_REQUIRED"
  | "PREVIEW_FIX_DIAGNOSIS_REQUIRED"
  | "PRODUCTION_APPROVAL_REQUIRED"
  | "PREVIEW_FIX_COMPILE_FAILED"
  | "PREVIEW_FIX_INVOKE_FAILED"
  | "PREVIEW_FIX_TIMELINE_UNAVAILABLE"
  | "PREVIEW_FIX_RECEIPT_INVALID";

export class PreviewFixError extends Error {
  constructor(readonly code: PreviewFixErrorCode) {
    super(code);
    this.name = "PreviewFixError";
  }
}

export interface PreviewFixLoopInput {
  productionRoot: string;
  previewRoot: string;
  previewId: string;
  projectRef: string;
  applicationId: string;
  environmentId: string;
  /** Explicit governance choice. The loop does not infer required or none. */
  property: "transaction" | "idempotency";
  value: "required" | "none";
}

export interface PreviewDeployReceipt {
  schema: typeof PREVIEW_DEPLOY_RECEIPT_SCHEMA;
  deployed: false;
  published: false;
  live: false;
  target: "preview";
  preview_id: string;
  project_ref: string;
  application_id: string;
  environment_id: string;
  branch_ref: string;
  artifact_sha256: string;
  status: "recorded";
  graph: { modules: string[]; command: string; transaction: "required" | "none" };
  change: { file: string; written: true };
  diagnosis: { code: string; errorCode: string; file: string };
  test: { operation: string; ok: true };
  timeline: {
    requestId: string;
    operation: string;
    handler: "succeeded";
    failed: false;
    complete: boolean;
    missingStages: string[];
  };
  production: { written: false; approval: "required"; graphRead: true };
}

function fail(code: PreviewFixErrorCode): never {
  throw new PreviewFixError(code);
}

function inside(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return fromParent === "" || (!isAbsolute(fromParent) && fromParent !== ".." && !fromParent.startsWith(`..${sep}`));
}

async function realDirectory(path: string): Promise<string> {
  const resolved = resolve(path);
  let stat;
  try {
    stat = await lstat(resolved);
  } catch {
    return fail("PREVIEW_FIX_ROOT_UNSUPPORTED");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return fail("PREVIEW_FIX_ROOT_UNSUPPORTED");
  const real = await realpath(resolved);
  if (real !== resolved) return fail("PREVIEW_FIX_ROOT_UNSUPPORTED");
  return real;
}

async function treeDigest(root: string): Promise<string> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    if (files.length > MAX_FILES) return fail("PREVIEW_FIX_ROOT_UNSUPPORTED");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === "." || entry.name === ".." || entry.name.includes("..")) {
        return fail("PREVIEW_FIX_ROOT_UNSUPPORTED");
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        await walk(path);
      } else if (entry.isFile()) {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return fail("PREVIEW_FIX_ROOT_UNSUPPORTED");
        files.push(path);
      } else {
        return fail("PREVIEW_FIX_ROOT_UNSUPPORTED");
      }
    }
  }
  await walk(root);
  if (files.length > MAX_FILES) return fail("PREVIEW_FIX_ROOT_UNSUPPORTED");
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(relative(root, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function identity(input: PreviewFixLoopInput, branchRef: string): void {
  if (!PREVIEW_ID.test(input.previewId) || !PROJECT_REF.test(input.projectRef)
    || !RESOURCE_ID.test(input.applicationId) || !RESOURCE_ID.test(input.environmentId)
    || (input.property !== "transaction" && input.property !== "idempotency")
    || (input.value !== "required" && input.value !== "none")) {
    fail("PREVIEW_FIX_POLICY_REQUIRED");
  }
  if (applicationPreviewBranchRef(input.previewId) !== branchRef) fail("PREVIEW_FIX_IDENTITY_MISMATCH");
}

function matchingFix(diagnostics: readonly Diagnostic[], property: PreviewFixLoopInput["property"]): DiagnosticFix & { type: "set_command_mode" } {
  const errors = diagnostics.filter(diagnostic => diagnostic.severity === "error");
  const matches = errors.filter((diagnostic): diagnostic is Diagnostic & { fix: DiagnosticFix & { type: "set_command_mode" } } =>
    diagnostic.code === "invalid-command-mode"
    && diagnostic.fix?.type === "set_command_mode"
    && diagnostic.fix.property === property
    && typeof diagnostic.file === "string"
    && RELATIVE_FILE.test(diagnostic.file)
    && diagnostic.errorCode === "SC4012");
  const [match] = matches;
  if (errors.length !== 1 || matches.length !== 1 || !match?.fix || match.fix.type !== "set_command_mode") {
    return fail("PREVIEW_FIX_DIAGNOSIS_REQUIRED");
  }
  return match.fix;
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("PREVIEW_FIX_RECEIPT_INVALID");
  const entry = value as Record<string, unknown>;
  const present = Object.keys(entry);
  if (present.length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(entry, key))) {
    return fail("PREVIEW_FIX_RECEIPT_INVALID");
  }
  return entry;
}

function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) return fail("PREVIEW_FIX_RECEIPT_INVALID");
  return value;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some(item => typeof item !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(item))) {
    return fail("PREVIEW_FIX_RECEIPT_INVALID");
  }
  return [...value];
}

/** Closed check for the receipt this loop writes. Rejects a live or published claim. */
export function parsePreviewDeployReceipt(value: unknown): PreviewDeployReceipt {
  const root = record(value, [
    "schema", "deployed", "published", "live", "target", "preview_id", "project_ref", "application_id",
    "environment_id", "branch_ref", "artifact_sha256", "status", "graph", "change", "diagnosis", "test",
    "timeline", "production",
  ]);
  if (root.schema !== PREVIEW_DEPLOY_RECEIPT_SCHEMA || root.deployed !== false || root.published !== false
    || root.live !== false || root.target !== "preview" || root.status !== "recorded") {
    return fail("PREVIEW_FIX_RECEIPT_INVALID");
  }
  const graph = record(root.graph, ["modules", "command", "transaction"]);
  const change = record(root.change, ["file", "written"]);
  const diagnosis = record(root.diagnosis, ["code", "errorCode", "file"]);
  const test = record(root.test, ["operation", "ok"]);
  const timeline = record(root.timeline, ["requestId", "operation", "handler", "failed", "complete", "missingStages"]);
  const production = record(root.production, ["written", "approval", "graphRead"]);
  if (change.written !== true || test.ok !== true || timeline.handler !== "succeeded" || timeline.failed !== false
    || typeof timeline.complete !== "boolean" || production.written !== false || production.approval !== "required"
    || production.graphRead !== true || (graph.transaction !== "required" && graph.transaction !== "none")) {
    return fail("PREVIEW_FIX_RECEIPT_INVALID");
  }
  const previewId = text(root.preview_id, PREVIEW_ID);
  const branchRef = text(root.branch_ref, /^pv[a-f0-9]{18}$/);
  if (applicationPreviewBranchRef(previewId) !== branchRef) return fail("PREVIEW_FIX_RECEIPT_INVALID");
  return {
    schema: PREVIEW_DEPLOY_RECEIPT_SCHEMA,
    deployed: false,
    published: false,
    live: false,
    target: "preview",
    preview_id: previewId,
    project_ref: text(root.project_ref, PROJECT_REF),
    application_id: text(root.application_id, RESOURCE_ID),
    environment_id: text(root.environment_id, RESOURCE_ID),
    branch_ref: branchRef,
    artifact_sha256: text(root.artifact_sha256, /^[a-f0-9]{64}$/),
    status: "recorded",
    graph: {
      modules: stringList(graph.modules),
      command: text(graph.command, /^[A-Za-z0-9_.:-]{1,128}$/),
      transaction: graph.transaction,
    },
    change: { file: text(change.file, RELATIVE_FILE), written: true },
    diagnosis: {
      code: text(diagnosis.code, /^[a-z0-9-]{1,64}$/),
      errorCode: text(diagnosis.errorCode, /^SC[0-9]{4}$/),
      file: text(diagnosis.file, RELATIVE_FILE),
    },
    test: { operation: text(test.operation, /^[A-Za-z0-9_.:-]{1,128}$/), ok: true },
    timeline: {
      requestId: text(timeline.requestId, /^[A-Za-z0-9._:-]{1,256}$/),
      operation: text(timeline.operation, /^[A-Za-z0-9_.:-]{1,128}$/),
      handler: "succeeded",
      failed: false,
      complete: timeline.complete,
      missingStages: stringList(timeline.missingStages),
    },
    production: { written: false, approval: "required", graphRead: true },
  };
}

async function writeInside(root: string, name: string, contents: string): Promise<void> {
  if (name !== EVENTS_FILE && name !== RECEIPT_FILE) return fail("PREVIEW_FIX_ROOT_UNSUPPORTED");
  const path = join(root, name);
  if (!inside(root, path)) return fail("PRODUCTION_APPROVAL_REQUIRED");
  await writeFile(path, contents, { encoding: "utf8", flag: "wx", mode: 0o644 });
}

/**
 * One pass inside an already isolated preview directory.
 * Reads the application graph, applies one explicit command-mode fix, compiles,
 * invokes `execute`, and reads that invoke's timeline. Production is hashed and
 * only read. This does not provision a preview and does not deploy.
 */
export async function runPreviewFixLoop(input: PreviewFixLoopInput): Promise<PreviewDeployReceipt> {
  const branchRef = basename(resolve(input.previewRoot));
  identity(input, branchRef);
  const productionRoot = await realDirectory(input.productionRoot);
  const previewRoot = await realDirectory(input.previewRoot);
  if (basename(previewRoot) !== branchRef || productionRoot === previewRoot
    || inside(productionRoot, previewRoot) || inside(previewRoot, productionRoot)) {
    return fail("PREVIEW_FIX_IDENTITY_MISMATCH");
  }
  const productionBefore = await treeDigest(productionRoot);
  let previewGraph;
  let productionGraph;
  try {
    previewGraph = await analyzeProject(previewRoot);
    productionGraph = await analyzeProject(productionRoot);
  } catch (error) {
    if (error instanceof PreviewFixError) throw error;
    return fail("PREVIEW_FIX_DIAGNOSIS_REQUIRED");
  }
  if (!productionGraph.modules) return fail("PREVIEW_FIX_DIAGNOSIS_REQUIRED");
  const fix = matchingFix(previewGraph.diagnostics ?? [], input.property);
  const chosen = { ...fix, value: input.value };
  const previewed = await applyDiagnosticFix(chosen, { rootDir: previewRoot });
  if (!previewed.changed || !inside(previewRoot, previewed.file)) return fail("PREVIEW_FIX_DIAGNOSIS_REQUIRED");
  const applied = await applyDiagnosticFix(chosen, { rootDir: previewRoot, dryRun: false });
  if (!applied.changed || !inside(previewRoot, applied.file)) return fail("PRODUCTION_APPROVAL_REQUIRED");
  if (await treeDigest(productionRoot) !== productionBefore) return fail("PRODUCTION_APPROVAL_REQUIRED");

  const compiled = await compileProject({ rootDir: previewRoot, outDir: join(previewRoot, "generated") });
  const command = compiled.graph.modules.flatMap(module => module.commands).find(item => item.className === fix.command);
  const policyApplied = input.property === "transaction"
    ? command?.transaction === input.value
    : command?.idempotency === input.value;
  if (compiled.diagnostics.some(diagnostic => diagnostic.severity === "error") || !command || !policyApplied) {
    return fail("PREVIEW_FIX_COMPILE_FAILED");
  }

  const sourceFile = join(previewRoot, fix.targetFile);
  const sourceReal = await realpath(sourceFile).catch(() => fail("PREVIEW_FIX_INVOKE_FAILED"));
  if (!inside(previewRoot, sourceReal)) return fail("PRODUCTION_APPROVAL_REQUIRED");
  const started = performance.now();
  // The evaluator runs in a child process so this file has no computed import().
  let status = 1;
  try {
    const child = Bun.spawn([
      process.versions.bun ? process.execPath : "bun",
      "--no-env-file",
      "-e",
      [
        "const imported = await import(process.argv[1]);",
        "const ctor = imported[process.argv[2]];",
        "if (typeof ctor !== \"function\") process.exit(2);",
        "const instance = new ctor();",
        "if (typeof instance.execute !== \"function\") process.exit(3);",
        "const output = await instance.execute();",
        "process.exit(output && typeof output === \"object\" && output.ok === true ? 0 : 4);",
      ].join("\n"),
      "--",
      pathToFileURL(sourceReal).href,
      fix.command,
    ], {
      cwd: previewRoot,
      env: { PATH: process.env.PATH ?? "" },
      stdout: "ignore",
      stderr: "ignore",
    });
    const timer = setTimeout(() => child.kill(), 10_000);
    status = await child.exited.finally(() => clearTimeout(timer));
  } catch {
    return fail("PREVIEW_FIX_INVOKE_FAILED");
  }
  if (status !== 0) return fail("PREVIEW_FIX_INVOKE_FAILED");
  const durationMs = Math.max(0, performance.now() - started);
  const requestId = `preview-${input.previewId}`;
  const events = {
    version: 1,
    events: [
      { kind: "command", operation: command.name, stage: "handler", phase: "started", requestId, attempt: 1 },
      { kind: "command", operation: command.name, stage: "handler", phase: "succeeded", requestId, attempt: 1, durationMs },
    ],
  };
  await writeInside(previewRoot, EVENTS_FILE, `${JSON.stringify(events)}\n`);
  const eventsPath = join(previewRoot, EVENTS_FILE);
  let pack;
  try {
    pack = createExecutionContextPack(compiled.graph, command.name, await readExecutionMetadata(eventsPath), requestId);
  } catch {
    return fail("PREVIEW_FIX_TIMELINE_UNAVAILABLE");
  }
  const entry = pack.timeline.find(item => item.kind === "command" && item.operation === command.name);
  const attempt = entry?.attempts[0];
  const handler = attempt?.stages.find(stage => stage.stage === "handler" && stage.phase === "succeeded");
  if (!entry || !attempt || !handler || attempt.failed || pack.requestId !== requestId) {
    return fail("PREVIEW_FIX_TIMELINE_UNAVAILABLE");
  }
  const artifactPath = join(previewRoot, "generated", "application.ts");
  const artifactReal = await realpath(artifactPath).catch(() => fail("PREVIEW_FIX_COMPILE_FAILED"));
  if (!inside(previewRoot, artifactReal)) return fail("PRODUCTION_APPROVAL_REQUIRED");
  const artifact = await readFile(artifactReal);
  const receipt = parsePreviewDeployReceipt({
    schema: PREVIEW_DEPLOY_RECEIPT_SCHEMA,
    deployed: false,
    published: false,
    live: false,
    target: "preview",
    preview_id: input.previewId,
    project_ref: input.projectRef,
    application_id: input.applicationId,
    environment_id: input.environmentId,
    branch_ref: branchRef,
    artifact_sha256: createHash("sha256").update(artifact).digest("hex"),
    status: "recorded",
    graph: {
      modules: compiled.graph.modules.map(module => module.name),
      command: command.name,
      transaction: command.transaction,
    },
    change: { file: relative(previewRoot, applied.file), written: true },
    diagnosis: { code: "invalid-command-mode", errorCode: "SC4012", file: fix.targetFile },
    test: { operation: command.name, ok: true },
    timeline: {
      requestId,
      operation: command.name,
      handler: "succeeded",
      failed: false,
      complete: attempt.complete,
      missingStages: attempt.missingStages,
    },
    production: { written: false, approval: "required", graphRead: true },
  });
  await writeInside(previewRoot, RECEIPT_FILE, `${JSON.stringify(receipt, null, 2)}\n`);
  if (await treeDigest(productionRoot) !== productionBefore) return fail("PRODUCTION_APPROVAL_REQUIRED");
  const written = parsePreviewDeployReceipt(JSON.parse(await readFile(join(previewRoot, RECEIPT_FILE), "utf8")));
  if (written.deployed !== false || written.production.written !== false) return fail("PREVIEW_FIX_RECEIPT_INVALID");
  return written;
}
