import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "../packages/compiler/node_modules/@typescript/typescript6/lib/typescript.js";

const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const EXCLUDED_DIRECTORIES = new Set([
  ".svelte-kit", "dist", "generated", ".generated", "node_modules",
  "tests", "test", "__tests__", "fixtures", "__fixtures__",
]);

export interface PlatformSourceFinding {
  file: string;
  line: number;
  column: number;
  kind: "explicit-any" | "type-suppression";
  text: string;
}

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) files.push(...sourceFiles(path));
      continue;
    }
    if (!entry.isFile()) continue;
    if (SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
      if (!/(?:^|[._-])(test|spec)(?:[._-]|$)/u.test(entry.name)) files.push(path);
    } else if (entry.name.endsWith(".svelte")) {
      files.push(path);
    }
  }
  return files.sort();
}

function lineAndColumn(source: string, position: number): { line: number; column: number } {
  const before = source.slice(0, position);
  const lineStart = before.lastIndexOf("\n") + 1;
  return {
    line: before.split("\n").length,
    column: position - lineStart + 1,
  };
}

function scanTypeScript(
  root: string,
  file: string,
  sourceText: string,
  displaySource = sourceText,
  sourceOffset = 0,
): PlatformSourceFinding[] {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const findings: PlatformSourceFinding[] = [];
  const comments = new Set<number>();
  const report = (position: number, kind: PlatformSourceFinding["kind"], text: string): void => {
    const location = lineAndColumn(displaySource, sourceOffset + position);
    findings.push({ file: relative(root, file), ...location, kind, text });
  };
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      report(node.getStart(source), "explicit-any", "explicit any is forbidden in platform production source");
    }
    for (const range of [
      ...ts.getLeadingCommentRanges(sourceText, node.pos) ?? [],
      ...ts.getTrailingCommentRanges(sourceText, node.end) ?? [],
    ]) {
      if (comments.has(range.pos)) continue;
      comments.add(range.pos);
      const text = sourceText.slice(range.pos, range.end);
      const directive = file.includes(".typecheck.")
        ? /@ts-(?:ignore|nocheck)\b/u
        : /@ts-(?:ignore|nocheck|expect-error)\b/u;
      const match = directive.exec(text);
      if (match) report(range.pos + match.index, "type-suppression", "production type-checking suppressions are forbidden");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

function scanFile(root: string, file: string): PlatformSourceFinding[] {
  const source = readFileSync(file, "utf8");
  const findings: PlatformSourceFinding[] = [];
  if (file.endsWith(".svelte")) {
    const require = createRequire(new URL("../packages/web-console/package.json", import.meta.url));
    const compiler: unknown = require("svelte/compiler");
    if (!isRecord(compiler) || typeof compiler["parse"] !== "function") throw new Error("Svelte compiler is required");
    const ast: unknown = compiler["parse"](source, { modern: true });
    const seen = new Set<object>();
    const visit = (node: unknown): void => {
      if (node === null || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const child of node) visit(child);
        return;
      }
      if (!isRecord(node)) return;
      if (node["type"] === "TSAnyKeyword" && typeof node["start"] === "number") {
        findings.push({
          file: relative(root, file), ...lineAndColumn(source, node["start"]),
          kind: "explicit-any", text: "explicit any is forbidden in platform production source",
        });
      }
      if ((node["type"] === "Line" || node["type"] === "Block" || node["type"] === "Comment")
        && typeof node["value"] === "string" && typeof node["start"] === "number") {
        const match = /@ts-(?:ignore|nocheck|expect-error)\b/u.exec(node["value"]);
        if (match) findings.push({
          file: relative(root, file), ...lineAndColumn(source, node["start"]),
          kind: "type-suppression", text: "production type-checking suppressions are forbidden",
        });
      }
      for (const child of Object.values(node)) visit(child);
    };
    visit(ast);
  } else {
    findings.push(...scanTypeScript(root, file, source));
  }

  return findings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function scanPlatformSource(root: string): PlatformSourceFinding[] {
  const packageRoot = resolve(root, "packages");
  const directories = existsSync(packageRoot)
    ? readdirSync(packageRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(packageRoot, entry.name))
    : [];
  directories.push(resolve(root, "scripts"));
  return directories.flatMap((directory) => sourceFiles(directory).flatMap((file) => scanFile(root, file)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dir, "..");
  const findings = scanPlatformSource(root);
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`${finding.file}:${finding.line}:${finding.column}: ${finding.text}`);
    }
    process.exitCode = 1;
  } else {
    console.log("Platform production source contains no explicit any or type-checking suppressions.");
  }
}
