/**
 * Swagger Coverage Checker
 *
 * Scans route files for Elysia handlers (.get/.post/.put/.patch/.delete)
 * and reports those missing `detail: { tags, summary }` annotations.
 *
 * Usage:
 *   bun run scripts/check-swagger-coverage.ts            # warn only (exit 0)
 *   bun run scripts/check-swagger-coverage.ts --strict    # fail on missing (exit 1)
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTES_DIR = join(import.meta.dir, "..", "src", "routes");
const strict = process.argv.includes("--strict");

// Files that are re-exports or non-route files — skip them
const SKIP_FILES = new Set(["index.ts", "projects.ts"]);

// Regex: matches Elysia method chain calls like .get( .post( .put( .patch( .delete(
const HANDLER_RE =
  /^\s*\.(get|post|put|patch|delete)\s*\(\s*["'`]/;

// Regex: matches detail: inside an options object
const DETAIL_RE = /detail\s*:\s*\{/;

interface Finding {
  file: string;
  line: number;
  method: string;
  path: string;
}

const findings: Finding[] = [];
let totalHandlers = 0;
let coveredHandlers = 0;

const files = readdirSync(ROUTES_DIR)
  .filter((f) => f.endsWith(".ts") && !SKIP_FILES.has(f))
  .sort();

for (const file of files) {
  const filePath = join(ROUTES_DIR, file);
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  // Track brace depth to find the end of each handler's options object
  // Strategy: when we see a handler line, look ahead for `detail:` before the
  // options object closes. This is simpler than a full AST parse and works
  // well for Elysia's consistent coding style.

  let i = 0;
  while (i < lines.length) {
    const match = lines[i].match(HANDLER_RE);
    if (!match) {
      i++;
      continue;
    }

    const method = match[1].toUpperCase();
    totalHandlers++;

    // Extract the path argument (first string after the method)
    const pathMatch = lines[i].match(/\.\w+\s*\(\s*["'`]([^"'`]*)["'`]/);
    const routePath = pathMatch ? pathMatch[1] : "?";

    // Look ahead: scan forward to find either `detail:` or the end of the
    // options object (3rd argument). We track parentheses to know when
    // we've exited the method call.
    let hasDetail = false;
    let parenDepth = 0;
    let foundOptionsObject = false;
    let braceDepth = 0;

    for (let j = i; j < Math.min(i + 200, lines.length); j++) {
      const line = lines[j];

      // Count parens to track when we exit the method call
      for (const ch of line) {
        if (ch === "(") parenDepth++;
        if (ch === ")") parenDepth--;
      }

      // Check for detail annotation
      if (DETAIL_RE.test(line)) {
        hasDetail = true;
        break;
      }

      // If we've closed all parens of the method call, we're done
      if (parenDepth <= 0 && j > i) {
        break;
      }
    }

    if (hasDetail) {
      coveredHandlers++;
    } else {
      findings.push({ file, line: i + 1, method, path: routePath });
    }

    i++;
  }
}

// Report
console.log("\n=== Swagger Route Coverage Report ===\n");
console.log(`Total handlers: ${totalHandlers}`);
console.log(
  `With detail:    ${coveredHandlers} (${totalHandlers > 0 ? Math.round((coveredHandlers / totalHandlers) * 100) : 0}%)`,
);
console.log(`Missing detail: ${findings.length}`);

if (findings.length > 0) {
  console.log("\nHandlers missing `detail: { tags, summary }`:\n");

  // Group by file
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const arr = byFile.get(f.file) || [];
    arr.push(f);
    byFile.set(f.file, arr);
  }

  for (const [file, items] of byFile) {
    console.log(`  ${file}:`);
    for (const item of items) {
      console.log(
        `    L${item.line}  ${item.method.padEnd(7)} ${item.path}`,
      );
    }
    console.log();
  }
}

if (strict && findings.length > 0) {
  console.error(
    `\nERROR: ${findings.length} handler(s) missing Swagger detail annotations.`,
  );
  console.error("Run without --strict to see warnings only.");
  process.exit(1);
}

console.log(
  strict ? "\nAll handlers have Swagger detail annotations.\n" : "",
);
