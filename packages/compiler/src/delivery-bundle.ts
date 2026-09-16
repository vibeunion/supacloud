import { isBuiltin } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as ts from "@typescript/typescript6";
import { digest } from "./delivery-files";
import type { DeliveryOptions } from "./delivery-schema";

export interface BundledDeliveryTarget {
  files: Map<string, Uint8Array>;
  inputs: Map<string, string>;
  runtimeImports: string[];
}

/** Reject direct computed module loads: their dependency closure cannot be bundled statically. */
function checkStaticImports(path: string, contents: Uint8Array): void {
  if (!/\.[cm]?[jt]sx?$/.test(path)) return;
  const source = ts.createSourceFile(path, new TextDecoder().decode(contents), ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0];
      if (!argument || (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))) {
        throw new Error("Computed module loading is not supported in independent delivery bundles.");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

export async function bundleDeliveryTarget(
  name: string,
  code: string,
  project: string,
  generatedDirectory: string,
  options: DeliveryOptions,
): Promise<BundledDeliveryTarget> {
  const inputs = new Map<string, string>();
  const workingDirectory = process.cwd();
  const virtual = `supacloud-delivery:${name}`;
  const result = await Bun.build({
    entrypoints: [virtual],
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
        // Bun can label imports of a virtual entry as file-namespace imports.
        // Match its unique importer as well as the custom namespace below.
        build.onResolve({ filter: /.*/ }, (args) => args.importer === name
          ? { path: Bun.resolveSync(args.path, generatedDirectory), namespace: "file" }
          : undefined);
        build.onResolve({ filter: /^supacloud-delivery:/ }, () => ({ path: name, namespace: "supacloud-delivery" }));
        build.onResolve({ filter: /.*/, namespace: "supacloud-delivery" }, (args) => ({
          path: Bun.resolveSync(args.path, generatedDirectory), namespace: "file",
        }));
        build.onLoad({ filter: /.*/, namespace: "supacloud-delivery" }, () => ({ contents: code, loader: "ts" }));
        build.onLoad({ filter: /.*/, namespace: "file" }, async (args) => {
          const bytes = await readFile(args.path);
          checkStaticImports(args.path, bytes);
          inputs.set(resolve(args.path), digest(bytes));
          return { contents: bytes, loader: args.loader };
        });
      },
    }],
  });
  if (!result.success || !result.metafile) throw new Error("Independent bundle failed or has no dependency metadata.");
  const runtimeImports = new Set<string>();
  for (const [path, metadata] of Object.entries(result.metafile.inputs)) {
    // Metafile paths are relative to the invoking process, not BuildConfig.root.
    if (path !== virtual && !inputs.has(resolve(workingDirectory, path))) {
      throw new Error("Bundler reported an input that was not captured by the delivery snapshot.");
    }
    for (const imported of metadata.imports) {
      if (!imported.external) continue;
      if (!isBuiltin(imported.path) && imported.path !== "bun" && !imported.path.startsWith("bun:")) {
        throw new Error("Independent bundles cannot retain external package imports.");
      }
      runtimeImports.add(imported.path);
    }
  }
  const files = new Map<string, Uint8Array>();
  for (const output of result.outputs) {
    const path = output.path.replace(/^\.\//, "");
    // Every bundler output is inside this target; no shared external chunks.
    if (path.startsWith("/") || path.split("/").some((part) => part === "..")) {
      throw new Error("Bundler output escapes the target package.");
    }
    files.set(`bundle/${path}`, new Uint8Array(await output.arrayBuffer()));
  }
  if (!files.has("bundle/index.js")) throw new Error("Independent bundle has no index.js entrypoint.");
  // Some native loaders do not appear as normal module imports. Their emitted assets
  // are included above, but deployment still has to attest the destination platform.
  for (const [path, hash] of inputs) {
    if (digest(await readFile(path)) !== hash) throw new Error("Source changed during bundling; retry the build.");
  }
  return { files, inputs, runtimeImports: [...runtimeImports].sort() };
}
