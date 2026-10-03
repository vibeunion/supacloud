import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { graphReport, readWorkspace, affectedReport } from './model.mjs';
import { changedInputs } from './cli.mjs';
import { verificationRelations } from './verification.mjs';
import { cacheEligible } from './cache.mjs';

/** One read model for CLI/editor/agent clients; task edges never become runtime dependencies. */
export function contextReport(workspace, source, changed = { files: [], fallbackReason: 'No baseline supplied.' }) {
  const verification = verificationRelations(workspace);
  const taskEdges = verification.flatMap((entry) => entry.verify.flatMap((target) =>
    (target.projects ?? []).map((project) => ({ source: entry.project, target: project, kind: 'verification', local: false }))));
  const sourceEdges = source.edges.map((edge) => ({ ...edge, kind: 'source', local: false }));
  const uncertain = source.diagnostics.length > 0 || source.notes.length > 0;
  const affected = affectedReport({ ...workspace, edges: [...workspace.edges, ...sourceEdges, ...taskEdges] },
    changed.files, changed.fallbackReason ?? (uncertain ? 'Unresolved source-boundary/coverage findings require full validation.' : undefined));
  return {
    schemaVersion: 1, kind: 'supacloud-workspace-context',
    graph: graphReport(workspace), source, verification, affected,
    caches: Object.values(workspace.projects).map((project) => ({ project: project.name, build: cacheEligible(project), remote: false })),
    limitations: ['Static JS/TS coverage is not whole-program analysis.', 'No report authorizes CI skipping.',
      'Known source debt remains visible; successful budget checks do not prove a clean architecture.'],
  };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--base' || args[1].startsWith('--'))) throw new Error('Usage: workspace:context [--base REF]');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const require = createRequire(new URL('../../packages/compiler/package.json', import.meta.url));
  const ts = require('@typescript/typescript6');
  const { WORKSPACE_BOUNDARY_RULES } = await import('../check_workspace_boundaries.ts');
  const { checkSourceBoundaries } = await import('./source.mjs');
  const workspace = readWorkspace(root);
  console.log(JSON.stringify(contextReport(workspace, checkSourceBoundaries(workspace, ts, WORKSPACE_BOUNDARY_RULES),
    changedInputs(root, args[1])), null, 2));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
