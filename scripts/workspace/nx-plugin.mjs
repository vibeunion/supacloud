import { buildCachePolicy } from './cache-policy.mjs';
import { ACCEPTANCE_PROJECT, preparationTargets, readWorkspace } from './model.mjs';
import { cacheEligible } from './cache.mjs';
import { verificationTargets } from './verification.mjs';

/** Nx owns execution/deduplication. No generated application imports this plugin. */
export function projectTargets(workspace, project) {
  const install = {
    executor: 'nx:run-commands', cache: false,
    options: { command: 'bun install --force --ignore-scripts --frozen-lockfile', cwd: project.root },
    dependsOn: preparationTargets(workspace, project.name),
  };
  const targets = {
    'repo-install': install,
    'repo-verify-prepare': { executor: 'nx:noop', cache: false, dependsOn: verificationTargets(workspace, project) },
    'repo-prepare': { executor: 'nx:noop', cache: false, dependsOn: preparationTargets(workspace, project.name),
      metadata: { description: 'Build/install only local prerequisites; do not install or build this consumer.' } },
  };
  if (cacheEligible(project)) {
    targets['repo-cache-guard'] = {
      executor: 'nx:run-commands', cache: false,
      options: { command: 'node scripts/workspace/cache.mjs', cwd: '.' },
      dependsOn: [{ target: 'repo-install', params: 'ignore' }],
      metadata: { description: 'Uncached cache-input/output preflight; hashing errors alone are not an execution gate.' },
    };
  }
  for (const script of ['build', 'test', 'typecheck', 'typecheck:test', 'check']) {
    if (typeof project.scripts[script] !== 'string') continue;
    targets[`repo-${script.replaceAll(':', '-')}`] = {
      executor: 'nx:run-commands', cache: false,
      options: { command: `bun run ${script}`, cwd: project.root },
      dependsOn: [{ target: script === 'build' && cacheEligible(project) ? 'repo-cache-guard' : 'repo-install', params: 'ignore' }],
      inputs: ['default', '^default'],
      ...(script === 'build' ? { outputs: ['{projectRoot}/dist'] } : {}),
      metadata: { description: `Opt-in Bun ${script}; result caching is disabled until package-specific acceptance.` },
      ...(script === 'build' ? buildCachePolicy(project) : {}),
    };
  }
  return targets;
}

export const createNodesV2 = [
  'packages/*/project.json',
  async (files, _options, context) => {
    const workspace = readWorkspace(context.workspaceRoot);
    const byRoot = new Map(Object.values(workspace.projects).map((project) => [project.root, project]));
    const results = files.map((file) => {
      const root = file.slice(0, -'/project.json'.length);
      const project = byRoot.get(root);
      if (!project) throw new Error(`Unowned project configuration: ${file}`);
      return [file, { projects: { [root]: { name: project.name, targets: projectTargets(workspace, project) } } }];
    });
    if (results.length) {
      results[0][1].projects['scripts/workspace'] = {
        name: ACCEPTANCE_PROJECT,
        tags: ['scope:tooling', 'type:acceptance'],
        implicitDependencies: Object.keys(workspace.projects).sort(),
        targets: {
          'app-generation': {
            executor: 'nx:run-commands', cache: false,
            options: { command: 'bun run scripts/check_app_generation.ts', cwd: '.' },
            metadata: { description: 'Existing packed CLI/generated-consumer acceptance; no cached result.' },
          },
        },
      };
    }
    return results;
  },
];

export async function createDependencies(_options, context) {
  const workspace = readWorkspace(context.workspaceRoot);
  const unique = new Map();
  for (const edge of workspace.edges) {
    // Include manifest inputs even when Nx's package-manager workspace is not enabled.
    const dependency = { source: edge.source, target: edge.target, sourceFile: edge.sourceFile, type: 'static' };
    unique.set(`${edge.source}\0${edge.target}`, dependency);
  }
  return [...unique.values()];
}
