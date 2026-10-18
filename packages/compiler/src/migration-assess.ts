import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checkProject } from "./compile";
import { checkMigrationDependencies, migrationDependencies } from "./migration-policy";
import { diffOpenApiDocuments, readOpenApiJson, type OpenApiDiffResult } from "./openapi-tools";
import type { CompileOptions, Diagnostic } from "./types";

export type MigrationAssessmentStatus =
  | "compatible"
  | "needs-review"
  | "breaking"
  | "unsupported"
  | "not-proven";

export type MigrationRenderMode = "unspecified" | "browser" | "ssr" | "edge" | "trusted-server";

export interface MigrationAssessmentFinding {
  code: string;
  status: MigrationAssessmentStatus;
  message: string;
  evidence?: string;
  remediation?: string;
}

export interface MigrationAssessmentOptions {
  projectDir: string;
  compile: CompileOptions;
  baselineOpenApiPath?: string;
  currentOpenApiPath?: string;
  renderMode?: MigrationRenderMode;
}

export interface MigrationAssessmentResult {
  version: 1;
  ok: boolean;
  status: MigrationAssessmentStatus;
  readOnly: true;
  writesPerformed: false;
  rendering: {
    selected: MigrationRenderMode;
    ssrRequired: false;
    supportedModes: readonly ["browser", "ssr", "edge", "trusted-server"];
    guidance: string;
  };
  dependencies: {
    expected: Readonly<Record<string, string>>;
    problems: string[];
  };
  compiler: {
    upToDate: boolean;
    diagnostics: Diagnostic[];
    mismatches: string[];
  };
  artifacts: {
    contractsManifest: {
      path: string;
      present: boolean;
      sha256?: string;
      version?: number;
      commands?: number;
      jobs?: number;
      routes?: number;
      permissions?: number;
      features?: number;
    };
    openApi?: {
      baselinePath: string;
      baselineSha256: string;
      currentPath: string;
      currentSha256: string;
      diff: OpenApiDiffResult;
    };
  };
  findings: MigrationAssessmentFinding[];
}

const STATUS_PRIORITY: Record<MigrationAssessmentStatus, number> = {
  compatible: 0,
  "needs-review": 1,
  "not-proven": 2,
  unsupported: 3,
  breaking: 4,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function arrayLength(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function safeField(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function validFeaturePersistence(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const boundary = value["boundary"];
  const receipt = value["receipt"];
  const reconciliation = value["reconciliation"];
  if (boundary === "database") {
    const fields = [value["tenantField"], value["versionField"], value["stateField"]];
    return value["optimisticLock"] === "required"
      && fields.every(safeField)
      && new Set(fields).size === 3
      && receipt === "required"
      && reconciliation === "none";
  }
  if (boundary === "external") {
    return value["optimisticLock"] === "none"
      && value["versionField"] === undefined
      && value["tenantField"] === undefined
      && value["stateField"] === undefined
      && receipt === "required"
      && reconciliation === "required";
  }
  return false;
}

function validFeatureInventory(value: unknown, jobs: readonly unknown[]): value is unknown[] {
  const featureNames = new Set<string>();
  return Array.isArray(value) && value.every((feature) => {
    if (!isRecord(feature) || typeof feature["name"] !== "string" || feature["name"].trim() === "") return false;
    if (featureNames.has(feature["name"])) return false;
    featureNames.add(feature["name"]);
    const states = feature["states"];
    const transitions = feature["transitions"];
    if (!Array.isArray(states) || states.length === 0
      || states.some((state) => typeof state !== "string" || state.trim() === "")
      || new Set(states).size !== states.length
      || !Array.isArray(transitions)) return false;
    const transitionNames = new Set<string>();
    return transitions.every((transition) => {
      if (!isRecord(transition)
        || typeof transition["name"] !== "string" || transition["name"].trim() === ""
        || typeof transition["from"] !== "string" || !states.includes(transition["from"])
        || typeof transition["to"] !== "string" || !states.includes(transition["to"])) return false;
      if (transitionNames.has(transition["name"])) return false;
      transitionNames.add(transition["name"]);
      const persistence = transition["persistence"];
      if (persistence !== undefined) {
        if (!validFeaturePersistence(persistence)) return false;
        if (typeof transition["command"] !== "string" || transition["command"].trim() === ""
          || typeof transition["permission"] !== "string" || transition["permission"].trim() === "") return false;
      }
      const job = transition["job"];
      if (job === undefined) return true;
      const details = transition["jobDetails"];
      const inventory = jobs.find((candidate) =>
        isRecord(candidate) && (candidate["name"] === job || candidate["className"] === job),
      );
      const contractFields = ["input", "inputKind", "output", "outputKind", "mode", "idempotency", "tenantScope"] as const;
      return typeof job === "string" && job.trim() !== ""
        && isRecord(details)
        && isRecord(inventory)
        && (details["name"] === job || details["className"] === job)
        && typeof details["className"] === "string" && details["className"].trim() !== ""
        && details["inputKind"] === "declared"
        && (details["mode"] === "task" || details["mode"] === "workflow")
        && details["idempotency"] === "required"
        && details["tenantScope"] === "required"
        && contractFields.every((field) => details[field] === inventory[field]);
    });
  });
}

function validJobInventory(value: unknown): value is unknown[] {
  const names = new Set<string>();
  const classes = new Set<string>();
  return Array.isArray(value) && value.every((job) => {
    if (!isRecord(job)
      || typeof job["name"] !== "string" || job["name"].trim() === ""
      || typeof job["className"] !== "string" || job["className"].trim() === ""
      || typeof job["module"] !== "string" || job["module"].trim() === "") return false;
    if (names.has(job["name"]) || classes.has(job["className"])) return false;
    names.add(job["name"]);
    classes.add(job["className"]);
    if (job["input"] !== undefined && (typeof job["input"] !== "string" || job["input"].trim() === "")) return false;
    if (job["inputKind"] !== undefined && job["inputKind"] !== "opaque" && job["inputKind"] !== "declared") return false;
    if (job["output"] !== undefined && (typeof job["output"] !== "string" || job["output"].trim() === "")) return false;
    if (job["outputKind"] !== undefined && job["outputKind"] !== "opaque" && job["outputKind"] !== "declared") return false;
    if (job["mode"] !== undefined && job["mode"] !== "task" && job["mode"] !== "workflow") return false;
    if (job["idempotency"] !== undefined && job["idempotency"] !== "required" && job["idempotency"] !== "none") return false;
    return job["tenantScope"] === undefined || job["tenantScope"] === "required" || job["tenantScope"] === "none";
  });
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function overallStatus(findings: readonly MigrationAssessmentFinding[]): MigrationAssessmentStatus {
  return findings.reduce<MigrationAssessmentStatus>((current, finding) =>
    STATUS_PRIORITY[finding.status] > STATUS_PRIORITY[current] ? finding.status : current, "compatible");
}

/** Build a local, read-only migration report. It never requires or enables SSR. */
export async function assessMigration(options: MigrationAssessmentOptions): Promise<MigrationAssessmentResult> {
  const projectDir = resolve(options.projectDir);
  const compile = {
    ...options.compile,
    rootDir: resolve(options.compile.rootDir),
    outDir: resolve(options.compile.outDir),
  };
  const findings: MigrationAssessmentFinding[] = [];
  const dependencyProblems = await checkMigrationDependencies(projectDir);
  if (dependencyProblems.length > 0) {
    findings.push({
      code: "migration-dependency-tuple-not-proven",
      status: "not-proven",
      message: "The installed compiler migration dependency tuple is not the exact tested tuple.",
      evidence: dependencyProblems.join("; "),
      remediation: "Install the exact tested package versions before applying a source migration.",
    });
  }

  let compiler: MigrationAssessmentResult["compiler"] = {
    upToDate: false,
    diagnostics: [],
    mismatches: [],
  };
  try {
    const checked = await checkProject(compile);
    compiler = {
      upToDate: checked.upToDate,
      diagnostics: checked.diagnostics,
      mismatches: checked.mismatches,
    };
    const errors = checked.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length > 0) {
      findings.push({
        code: "compiler-governance-not-proven",
        status: "not-proven",
        message: `Compiler governance has ${errors.length} error(s).`,
        remediation: "Resolve compiler diagnostics without weakening governance, then reassess.",
      });
    }
    if (!checked.upToDate) {
      findings.push({
        code: "generated-artifact-drift",
        status: "needs-review",
        message: "Generated artifacts do not match the current source and compiler configuration.",
        evidence: checked.mismatches.join("; "),
        remediation: "Regenerate candidate artifacts in isolation and review the diff before adoption.",
      });
    }
  } catch {
    findings.push({
      code: "compiler-check-unavailable",
      status: "not-proven",
      message: "The local compiler check could not complete.",
      remediation: "Verify the project source, configuration and installed dependencies, then reassess.",
    });
  }

  const contractsManifestPath = join(compile.outDir, "contracts.manifest.json");
  let contractsManifest: MigrationAssessmentResult["artifacts"]["contractsManifest"] = {
    path: contractsManifestPath,
    present: false,
  };
  try {
    const parsed: unknown = JSON.parse(await readFile(contractsManifestPath, "utf8"));
    if (!isRecord(parsed) || parsed["version"] !== 1
      || !validJobInventory(parsed["jobs"])
      || !validFeatureInventory(parsed["features"], parsed["jobs"])) {
      throw new Error("invalid manifest");
    }
    const commands = arrayLength(parsed["commands"]);
    const jobs = arrayLength(parsed["jobs"]);
    const routes = arrayLength(parsed["routes"]);
    const permissions = arrayLength(parsed["permissions"]);
    const features = arrayLength(parsed["features"]);
    contractsManifest = {
      path: contractsManifestPath,
      present: true,
      sha256: await sha256(contractsManifestPath),
      version: 1,
      ...(commands === undefined ? {} : { commands }),
      ...(jobs === undefined ? {} : { jobs }),
      ...(routes === undefined ? {} : { routes }),
      ...(permissions === undefined ? {} : { permissions }),
      ...(features === undefined ? {} : { features }),
    };
  } catch {
    findings.push({
      code: "contract-manifest-not-proven",
      status: "not-proven",
      message: "contracts.manifest.json is missing or invalid.",
      evidence: contractsManifestPath,
      remediation: "Generate and review the contract manifest before migration.",
    });
  }

  let openApi: MigrationAssessmentResult["artifacts"]["openApi"];
  if (options.baselineOpenApiPath && options.currentOpenApiPath) {
    const baselinePath = resolve(projectDir, options.baselineOpenApiPath);
    const currentPath = resolve(projectDir, options.currentOpenApiPath);
    try {
      const diff = diffOpenApiDocuments(
        await readOpenApiJson(baselinePath),
        await readOpenApiJson(currentPath),
      );
      openApi = {
        baselinePath,
        baselineSha256: await sha256(baselinePath),
        currentPath,
        currentSha256: await sha256(currentPath),
        diff,
      };
      if (!diff.ok) {
        findings.push({
          code: "openapi-breaking-change",
          status: "breaking",
          message: `OpenAPI contains ${diff.breaking.length} breaking change(s).`,
          remediation: "Review and explicitly approve or redesign each breaking contract change.",
        });
      } else if (diff.changes.length > 0) {
        findings.push({
          code: "openapi-compatible-change-review",
          status: "needs-review",
          message: `OpenAPI contains ${diff.changes.length} non-breaking change(s) requiring release review.`,
        });
      }
    } catch {
      findings.push({
        code: "openapi-diff-not-proven",
        status: "not-proven",
        message: "The OpenAPI baseline or current document could not be loaded.",
        remediation: "Export both OpenAPI documents as JSON and rerun the assessment.",
      });
    }
  } else {
    findings.push({
      code: "openapi-baseline-not-proven",
      status: "not-proven",
      message: "No complete OpenAPI baseline/current pair was supplied.",
      remediation: "Provide both --baseline-openapi and --current-openapi for compatibility evidence.",
    });
  }

  findings.push({
    code: "rendering-mode-preserved",
    status: "compatible",
    message: "SupaCloud migration does not require SSR and does not change the existing rendering topology.",
    evidence: `selected=${options.renderMode ?? "unspecified"}`,
  });

  const status = overallStatus(findings);
  return {
    version: 1,
    ok: status === "compatible" || status === "needs-review",
    status,
    readOnly: true,
    writesPerformed: false,
    rendering: {
      selected: options.renderMode ?? "unspecified",
      ssrRequired: false,
      supportedModes: ["browser", "ssr", "edge", "trusted-server"],
      guidance: "Keep the application's existing CSR, SPA, SSR or edge topology; use trusted adapters only for governed server operations.",
    },
    dependencies: {
      expected: migrationDependencies(),
      problems: dependencyProblems,
    },
    compiler,
    artifacts: {
      contractsManifest,
      ...(openApi === undefined ? {} : { openApi }),
    },
    findings,
  };
}

export function formatMigrationAssessment(result: MigrationAssessmentResult): string {
  return [
    `Migration assessment: ${result.status}. Read-only; no files, databases or remote environments were changed.`,
    `Rendering: ${result.rendering.selected}; SSR required: no.`,
    ...result.findings.map((finding) =>
      `${finding.status.toUpperCase()} ${finding.code}: ${finding.message}`),
  ].join("\n");
}
