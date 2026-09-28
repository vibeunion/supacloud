import { isBuiltin } from "node:module";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as ts from "@typescript/typescript6";
import { digest } from "./delivery-files";
import { staticDeliveryImports } from "./delivery-imports";
import { parseDeliveryBundleResponse, type DeliveryBundleRequest } from "./delivery-bundle-protocol";
import type { DeliveryOptions } from "./delivery-schema";

export interface BundledDeliveryTarget {
  files: Map<string, Uint8Array>;
  inputs: Map<string, string>;
  runtimeImports: string[];
}

export async function bundleDeliveryTarget(
  name: string,
  code: string,
  project: string,
  generatedDirectory: string,
  options: DeliveryOptions,
): Promise<BundledDeliveryTarget> {
  const worker = join(import.meta.dir, `delivery-bundle-worker.${import.meta.path.endsWith(".ts") ? "ts" : "js"}`);
  const environment: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  // Keep Bun's resolver independent of the caller's TypeScript analysis/cache.
  const child = Bun.spawn([process.execPath, "--no-env-file", worker], {
    cwd: project, env: environment, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  let interrupted = false;
  const terminate = () => { interrupted = true; child.kill("SIGTERM"); };
  process.on("SIGINT", terminate);
  process.on("SIGTERM", terminate);
  const timeout = setTimeout(() => { interrupted = true; child.kill("SIGKILL"); }, 300_000);
  try {
    const request: DeliveryBundleRequest = { parentPid: process.pid, name, code, project, generatedDirectory, options };
    child.stdin.write(JSON.stringify(request));
    child.stdin.end();
    const [stdout, , status] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (interrupted || status !== 0) throw new Error("Isolated delivery bundle failed.");
    const response = parseDeliveryBundleResponse(JSON.parse(stdout));
    if (!response.ok) throw new Error("Isolated delivery bundle failed.");
    return {
      files: new Map(response.files.map(([path, bytes]) => [path, new Uint8Array(Buffer.from(bytes, "base64"))])),
      inputs: new Map(response.inputs),
      runtimeImports: response.runtimeImports,
    };
  } finally {
    clearTimeout(timeout);
    process.removeListener("SIGINT", terminate);
    process.removeListener("SIGTERM", terminate);
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
  }
}

export async function bundleDeliveryTargetInProcess(
  name: string,
  code: string,
  project: string,
  generatedDirectory: string,
  options: DeliveryOptions,
): Promise<BundledDeliveryTarget> {
  const inputs = new Map<string, string>();
  const workingDirectory = process.cwd();
  const entry = resolve(generatedDirectory, `delivery-${name}.ts`);
  const entryPattern = new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  const result = await Bun.build({
    entrypoints: [entry],
    root: project,
    target: "bun",
    format: "esm",
    packages: "bundle",
    splitting: false,
    sourcemap: "none",
    env: "disable",
    minify: options.build?.minify ?? true,
    naming: { entry: "index.js", asset: "assets/[name]-[hash].[ext]", chunk: "chunks/[name]-[hash].[ext]" },
    metafile: true,
    throw: false,
    plugins: [{
      name: "supacloud-delivery-inputs",
      setup(build) {
        // A stable file-namespace entry lets Bun own normal package resolution.
        // Broad resolver callbacks can interfere with dependency re-exports.
        build.onResolve({ filter: entryPattern }, () => ({ path: entry, namespace: "file" }));
        build.onLoad({ filter: /.*/, namespace: "file" }, async (args) => {
          if (args.path === entry) return { contents: code, loader: "ts" };
          const bytes = await readFile(args.path);
          inputs.set(resolve(args.path), digest(bytes));
          return { contents: staticDeliveryImports(args.path, bytes), loader: args.loader };
        });
      },
    }],
  });
  if (!result.success || !result.metafile) throw new Error("Independent bundle failed or has no dependency metadata.");
  const runtimeImports = new Set<string>();
  for (const [path, metadata] of Object.entries(result.metafile.inputs)) {
    // Metafile paths are relative to the invoking process, not BuildConfig.root.
    if (resolve(workingDirectory, path) !== entry && !inputs.has(resolve(workingDirectory, path))) {
      throw new Error("Bundler reported an input that was not captured by the delivery snapshot.");
    }
    // Bun's input metadata can label tree-shaken re-exports and optional missing
    // requires as external. Check emitted code instead of rejecting those inputs.
    for (const imported of metadata.imports) {
      if (imported.external && (isBuiltin(imported.path) || imported.path === "bun" || imported.path.startsWith("bun:"))) {
        runtimeImports.add(imported.path);
      }
    }
  }
  const files = new Map<string, Uint8Array>();
  for (const output of result.outputs) {
    const path = output.path.replace(/^\.\//, "");
    // Every bundler output is inside this target; no shared external chunks.
    if (path.startsWith("/") || path.split("/").some((part) => part === "..")) {
      throw new Error("Bundler output escapes the target package.");
    }
    const bytes = new Uint8Array(await output.arrayBuffer());
    if (/\.[cm]?js$/.test(path)) {
      const source = ts.createSourceFile(path, new TextDecoder().decode(bytes), ts.ScriptTarget.Latest, true);
      function check(node: ts.Node): void {
        const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
            || (ts.isIdentifier(node.expression) && /^(?:__)?require$/.test(node.expression.text))
            || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "require"
              && ts.isMetaProperty(node.expression.expression) && node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword))
            ? node.arguments[0] : undefined;
        if (specifier && ts.isStringLiteralLike(specifier)) {
          if (!isBuiltin(specifier.text) && specifier.text !== "bun" && !specifier.text.startsWith("bun:")) {
            throw new Error("Independent bundles cannot retain external package imports.");
          }
          runtimeImports.add(specifier.text);
        }
        ts.forEachChild(node, check);
      }
      check(source);
    }
    files.set(`bundle/${path}`, bytes);
  }
  if (!files.has("bundle/index.js")) throw new Error("Independent bundle has no index.js entrypoint.");
  // Some native loaders do not appear as normal module imports. Their emitted assets
  // are included above, but deployment still has to attest the destination platform.
  for (const [path, hash] of inputs) {
    if (digest(await readFile(path)) !== hash) throw new Error("Source changed during bundling; retry the build.");
  }
  return { files, inputs, runtimeImports: [...runtimeImports].sort() };
}
