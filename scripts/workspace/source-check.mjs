import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { WORKSPACE_BOUNDARY_RULES } from '../check_workspace_boundaries.ts';
import { readJson, readWorkspace } from './model.mjs';
import { evaluateSourceBaseline } from './source-baseline.mjs';
import { checkSourceBoundaries } from './source.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--baseline')) throw new Error('Usage: source-check [--baseline]');
  // Reuse Compiler's installed TypeScript parser, not a second runtime dependency.
  const require = createRequire(new URL('../../packages/compiler/package.json', import.meta.url));
  const ts = require('@typescript/typescript6');
  const report = checkSourceBoundaries(readWorkspace(root), ts, WORKSPACE_BOUNDARY_RULES);
  if (args.length) {
    const baseline = readJson(new URL('./source-baseline.json', import.meta.url));
    const result = evaluateSourceBaseline(report, baseline);
    console.log(JSON.stringify({ ...report, gate: result }, null, 2));
    if (!result.passed) process.exitCode = 1;
  } else {
    console.log(JSON.stringify(report, null, 2));
    if (report.diagnostics.length) process.exitCode = 1;
  }
} catch (error) {
  console.error(`Source boundary check failed: ${error.message}`);
  process.exitCode = 1;
}
