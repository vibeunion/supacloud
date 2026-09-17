#!/usr/bin/env bun
/**
 * Verifies that docs/README.md stays in sync with the docs/ directory:
 * 1. Every docs/*.md file (top level, plus errors/ and examples/) must be
 *    referenced by a relative markdown link in docs/README.md — except
 *    per-code diagnostic pages under errors/ (indexed via errors/README.md)
 *    and the index files themselves (README.md, README.zh-CN.md).
 * 2. Every relative link in docs/README.md must resolve to an existing file.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const docsDir = join(repoRoot, "docs");
const indexFile = join(docsDir, "README.md");

const INDEX_FILES = new Set(["README.md", "README.zh-CN.md"]);
const ERRORS_DIR = "errors/";

const problems: string[] = [];

// Collect all markdown files under docs/ (top level + errors/ + examples/).
const allFiles: string[] = [];
for (const dir of [".", "errors", "examples"]) {
  const full = join(docsDir, dir);
  if (!existsSync(full)) continue;
  for (const name of readdirSync(full)) {
    if (!name.endsWith(".md")) continue;
    const rel = dir === "." ? name : `${dir}/${name}`;
    if (INDEX_FILES.has(rel)) continue;
    allFiles.push(rel);
  }
}
// Per-code diagnostic pages are indexed collectively via errors/README.md.
const mustIndex = allFiles.filter((f) => !f.startsWith(ERRORS_DIR));

const indexContent = readFileSync(indexFile, "utf8");

// 1. Every required file must be linked from the index.
const linked = new Set(
  [...indexContent.matchAll(/\]\(([^)#\s]+)\)/g)].map((m) => m[1]!),
);
for (const file of mustIndex) {
  const candidates = [`./${file}`, file, `../docs/${file}`];
  if (!candidates.some((c) => linked.has(c))) {
    problems.push(`docs/README.md does not reference docs/${file}`);
  }
}

// 2. Every relative link in the index must resolve.
for (const match of indexContent.matchAll(/\]\(([^)#\s]+)\)/g)) {
  const target = match[1]!;
  if (/^[a-z]+:\/\//i.test(target) || target.startsWith("/")) continue;
  const resolved = resolve(docsDir, target);
  if (!existsSync(resolved)) {
    problems.push(`docs/README.md links to missing file: ${target}`);
  }
}

if (problems.length > 0) {
  console.error("docs index check failed:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  `docs index check passed: ${allFiles.length} markdown files, index consistent.`,
);
