import { mkdir, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import * as ts from "@typescript/typescript6";
import { checkProject } from "./compile";
import { createDeliveryPlan } from "./delivery-plan";
import { parseDeliveryOptions, type DeliveryDiagnostic } from "./delivery-schema";
import { parseDeliveryBuildManifest, parseDeliveryBuildResult, type DeliveryBuildResult, type DeliveryObject } from "./delivery-build-schema";
import { renderDeliveryTarget } from "./delivery-render";
import { bundleDeliveryTarget } from "./delivery-bundle";
import { artifactInventory, canonical, digest, exists, inside, noLinks, publishPointer, readOwned, reserveOutput, sourceInventory, writeArtifact } from "./delivery-files";
import { scanGeneratedArtifacts } from "./type-safety";
import type { CompileOptions } from "./types";

const producer = "@supacloud/compiler/delivery-build-v1" as const;

/** Build local, independently importable factories. Never activates remote Functions. */
export async function buildDeliveryProject(
  options: CompileOptions,
  delivery?: unknown,
): Promise<DeliveryBuildResult> {
  const bundledTargets: string[] = [];
  let resultDiagnostics: DeliveryDiagnostic[] = [];
  const failed = (diagnostics: DeliveryDiagnostic[]): DeliveryBuildResult => {
    resultDiagnostics = [...diagnostics];
    return { ok: false, manifest: null, diagnostics: resultDiagnostics, written: [], bundledTargets };
  };
  let phase = "configuration";
  let output: Awaited<ReturnType<typeof reserveOutput>> | undefined;
  const temporary: string[] = [];
  try {
    const settings = parseDeliveryOptions(delivery);
    if (typeof Bun === "undefined") throw new Error("Independent delivery builds require Bun.");
    const configPath = ts.findConfigFile(resolve(options.rootDir), ts.sys.fileExists);
    if (!configPath) throw new Error("Independent delivery builds require a project tsconfig.json.");
    const lexicalProject = dirname(configPath);
    const project = await realpath(lexicalProject);
    const sourceRoot = await realpath(options.rootDir);
    if (!inside(project, sourceRoot)) throw new Error("Application sources must be inside the project.");
    const requested = resolve(options.outDir, "delivery");
    if (!inside(lexicalProject, requested)) throw new Error("Output must be inside the application project.");
    const buildRoot = resolve(project, relative(lexicalProject, requested));
    const generatedRoot = resolve(project, relative(lexicalProject, options.outDir));
    if (inside(generatedRoot, sourceRoot)) throw new Error("Output must not contain the application source root.");
    const configInputs = new Map<string, string>();
    const parsedConfig = ts.getParsedCommandLineOfConfigFile(await realpath(configPath), {}, {
      ...ts.sys,
      readFile(path) {
        const contents = readFileSync(path, "utf8");
        configInputs.set(resolve(path), digest(contents));
        return contents;
      },
      onUnRecoverableConfigFileDiagnostic() { throw new Error("Invalid project TypeScript configuration."); },
    });
    if (!parsedConfig || parsedConfig.errors.length > 0) throw new Error("Invalid project TypeScript configuration.");

    phase = "compiler-checks";
    const sources = await sourceInventory(sourceRoot, generatedRoot);
    const checked = await checkProject(options);
    const planned = createDeliveryPlan({ ...checked.graph, diagnostics: checked.diagnostics }, settings);
    if (!planned.ok) return failed(planned.diagnostics);
    if (options.graphql && checked.mismatches.some((mismatch) => mismatch.startsWith("graphql"))) {
      throw new Error("Refresh GraphQL artifacts with compile before building independent targets.");
    }
    const assets = settings.build?.assets ?? [];
    for (const asset of assets) {
      if (!planned.plan.targets.some((target) => target.name === asset.target)) {
        throw new Error("An asset refers to an unknown delivery target.");
      }
    }
    const assetOwners = assets.map((asset) => `${asset.target}/${asset.path}`);
    if (new Set(assetOwners).size !== assetOwners.length) throw new Error("Duplicate target asset path.");

    phase = "output-ownership";
    output = await reserveOutput(project, buildRoot);
    const objectRoot = join(output.path, "objects");
    await noLinks(output.path, objectRoot);
    await mkdir(objectRoot, { recursive: true });
    const pointer = join(output.path, "delivery.manifest.json");
    const previous = await exists(pointer)
      ? parseDeliveryBuildManifest(JSON.parse(new TextDecoder().decode(await readOwned(output.path, pointer))))
      : undefined;
    const objects: DeliveryObject[] = [];
    const candidates: Array<{ path: string; object: DeliveryObject }> = [];
    const snapshots = new Map([...sources, ...configInputs]);

    // Configuration and dependency resolution inputs invalidate every affected build.
    // Bun resolves afresh on every invocation; there is no persisted "skip bundler" cache.
    const configuration: Record<string, string> = {};
    let directory = project;
    while (true) {
      for (const name of ["package.json", "bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bunfig.toml", "tsconfig.json"]) {
        const path = join(directory, name);
        if (await exists(path)) {
          const bytes = await readFile(path);
          const before = snapshots.get(path);
          if (before !== undefined && before !== digest(bytes)) throw new Error("Configuration changed during analysis; retry.");
          snapshots.set(path, digest(bytes));
          configuration[relative(project, path).split(sep).join("/")] = digest(bytes);
        }
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    const toolchain = {
      producer, bun: Bun.version, revision: Bun.revision,
      compiler: digest(canonical(Object.fromEntries(
        [...await sourceInventory(import.meta.dir, join(import.meta.dir, "node_modules"))]
          .map(([path, hash]) => [relative(import.meta.dir, path), hash]),
      ))),
    };

    for (const target of planned.plan.targets) {
      phase = `target:${target.name}`;
      const stage = await mkdtemp(join(objectRoot, ".build-"));
      temporary.push(stage);
      // Same depth as the immutable object directory; no random staging names enter source imports.
      const generatedDirectory = join(objectRoot, "0".repeat(64), "generated");
      const rendered = renderDeliveryTarget(checked.graph, target, {
        ...options, rootDir: sourceRoot, outDir: generatedDirectory,
      });
      const generated: Record<string, string> = {
        "application.ts": rendered.applicationCode,
        ...(rendered.clientCode === undefined ? {} : { "client.ts": rendered.clientCode }),
        ...(rendered.permissionsCode === undefined ? {} : { "permissions.ts": rendered.permissionsCode }),
      };
      const unsafe = scanGeneratedArtifacts(generated, true);
      if (unsafe.some((item) => item.severity === "error")) return failed(unsafe);
      for (const [name, contents] of Object.entries(generated)) await writeArtifact(stage, `generated/${name}`, contents);

      {
        // Widen only the emit-path boundary to include compiler-owned source.
        // All application strictness and project-reference settings are preserved.
        const program = ts.createProgram({
          rootNames: [...parsedConfig.fileNames.filter((path) => !inside(generatedRoot, path)),
            ...Object.keys(generated).map((name) => join(stage, "generated", name))],
          options: { ...parsedConfig.options, rootDir: project },
          ...(parsedConfig.projectReferences ? { projectReferences: parsedConfig.projectReferences } : {}),
        });
        const diagnostics = ts.getPreEmitDiagnostics(program);
        if (diagnostics.some((item) => item.category === ts.DiagnosticCategory.Error)) {
          return failed(diagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error).map((item) => ({
            severity: "error", code: "delivery-generated-type-error",
            message: ts.flattenDiagnosticMessageText(item.messageText, "\n"),
            ...(item.file ? { file: item.file.fileName } : {}),
          })));
        }
      }

      const bundled = await bundleDeliveryTarget(target.name, rendered.applicationCode, project, join(stage, "generated"), settings);
      bundledTargets.push(target.name);
      for (const [path, hash] of bundled.inputs) {
        const previousHash = snapshots.get(path);
        if (previousHash !== undefined && previousHash !== hash) throw new Error("Shared source changed between target builds; retry.");
        snapshots.set(path, hash);
      }
      for (const [path, bytes] of bundled.files) await writeArtifact(stage, path, bytes);
      await writeArtifact(stage, "bundle/package.json", canonical({ type: "module", private: true }));
      await writeArtifact(stage, "bundle/app.manifest.json", rendered.manifestJson);
      await writeArtifact(stage, "bundle/target.json", canonical({
        target, entryKind: "compiled-module-factory", deploymentReady: false,
      }));
      const assetInputs: Record<string, string> = {};
      for (const asset of assets.filter((asset) => asset.target === target.name)) {
        const path = resolve(sourceRoot, asset.source);
        const bytes = await readOwned(sourceRoot, path);
        const hash = digest(bytes);
        const previousHash = snapshots.get(path);
        if (previousHash !== undefined && previousHash !== hash) throw new Error("Asset changed during build; retry.");
        snapshots.set(path, hash);
        assetInputs[asset.source] = hash;
        await writeArtifact(stage, `bundle/assets/${asset.path}`, bytes);
      }
      const inputDigest = digest(canonical({
        target, generated, toolchain, configuration,
        build: { minify: settings.build?.minify ?? true,
          environmentContract: settings.build?.environmentContract,
          assets: assets.filter((asset) => asset.target === target.name) },
        inputs: Object.fromEntries([...bundled.inputs].map(([path, hash]) =>
          [relative(project, path).split(sep).join("/"), hash])),
        assets: assetInputs,
      }));
      const files = await artifactInventory(stage);
      const object: DeliveryObject = {
        name: target.name, inputDigest,
        objectId: digest(canonical({ inputDigest, files })),
        entrypoint: "bundle/index.js", entryKind: "compiled-module-factory",
        runtimeImports: bundled.runtimeImports, files,
      };
      objects.push(object);
      candidates.push({ path: stage, object });
    }

    phase = "source-consistency";
    if (canonical(Object.fromEntries(sources)) !== canonical(Object.fromEntries(
      await sourceInventory(sourceRoot, generatedRoot),
    ))) throw new Error("Application sources changed during analysis; retry.");
    for (const [path, hash] of snapshots) {
      if (digest(await readFile(path)) !== hash) throw new Error("Build inputs changed before publication; retry.");
    }
    const manifest = parseDeliveryBuildManifest({
      schemaVersion: 1, producer, deploymentReady: false, plan: planned.plan, objects,
      routes: planned.plan.targets.flatMap((target) => target.routes.map((route) =>
        ({ method: route.method, path: route.path, target: target.name }))),
      jobs: planned.plan.targets.flatMap((target) => target.jobs.map((job) => ({ name: job.name, target: target.name }))),
    });
    phase = "artifact-integrity";
    for (const candidate of candidates) {
      const destination = join(objectRoot, candidate.object.objectId);
      await noLinks(output.path, destination);
      if (await exists(destination) && canonical(await artifactInventory(destination)) !== canonical(candidate.object.files)) {
        throw new Error("An immutable artifact was modified. Refusing to overwrite it.");
      }
    }
    const written: string[] = [];
    for (const candidate of candidates) {
      const destination = join(objectRoot, candidate.object.objectId);
      if (!await exists(destination)) {
        await rename(candidate.path, destination);
        written.push(...candidate.object.files.map((file) => join(destination, file.path)));
      }
    }
    // Only this pointer defines the active local build. Earlier immutable objects
    // remain available for rollback; failure never switches this pointer.
    phase = "manifest-publication";
    if (await publishPointer(output.path, canonical(manifest) + "\n")) written.push(pointer);
    const unchangedTargets = objects.filter((object) =>
      previous?.objects.some((old) => old.name === object.name && old.objectId === object.objectId)).map((object) => object.name);
    resultDiagnostics = [...planned.diagnostics];
    return parseDeliveryBuildResult({
      ok: true, manifest, diagnostics: resultDiagnostics, written, bundledTargets,
      unchangedTargets,
      changedTargets: objects.filter((object) => !unchangedTargets.includes(object.name)).map((object) => object.name),
      removedTargets: previous?.objects.filter((old) => !objects.some((object) => object.name === old.name)).map((old) => old.name) ?? [],
    });
  } catch {
    // Build errors can contain source snippets or values. Return the phase, not rejected data.
    return failed([{
      severity: "error", code: "delivery-build-failed",
      message: `Independent delivery build failed during ${phase}.`,
      suggestion: phase === "configuration" ? "Use Bun, a project tsconfig, valid delivery options and a project-local output directory."
        : phase === "output-ownership" ? "Use an empty output namespace or this project's owned directory; resolve locks and symlinks explicitly."
        : "Check compiler/type diagnostics, static imports, declared asset paths and artifact integrity; retry only after resolving the failure.",
    }]);
  } finally {
    const cleaned = await Promise.allSettled(temporary.map((path) => rm(path, { recursive: true, force: true })));
    try { await output?.release(); } catch {
      resultDiagnostics.push({ severity: "warn", code: "delivery-cleanup-failed", message: "Output lock cleanup failed; inspect the owned build directory before retrying." });
    }
    if (cleaned.some((result) => result.status === "rejected")) {
      resultDiagnostics.push({ severity: "warn", code: "delivery-cleanup-failed", message: "Some inactive staging directories could not be removed." });
    }
  }
}
