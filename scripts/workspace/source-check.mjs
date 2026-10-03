import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { WORKSPACE_BOUNDARY_RULES } from '../check_workspace_boundaries.ts';
import { readWorkspace } from './model.mjs';
import { checkSourceBoundaries } from './source.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
try {
  // Reuse Compiler's installed TypeScript parser, not a second runtime dependency.
  const require = createRequire(new URL('../../packages/compiler/package.json', import.meta.url));
  const ts = require('@typescript/typescript6');
  const report = checkSourceBoundaries(readWorkspace(root), ts, WORKSPACE_BOUNDARY_RULES);
  console.log(JSON.stringify(report, null, 2));
  if (report.diagnostics.length) process.exitCode = 1;
} catch (error) {
  console.error(`Source boundary check failed: ${error.message}`);
  process.exitCode = 1;
}
