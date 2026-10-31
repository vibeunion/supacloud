import { preparationTargets } from './model.mjs';
import { verificationTargets } from './verification.mjs';

const SCRIPTS = ['build', 'test', 'typecheck', 'typecheck:test', 'check'];

/**
 * Bun commands for repository tasks.
 * Dependency edges come from the workspace model. This is not a plugin system.
 */
export function taskPlan(workspace, project) {
  const tasks = {
    'repo-install': {
      command: ['bun', 'install', '--force', '--ignore-scripts', '--frozen-lockfile'],
      cwd: project.root,
      dependsOn: preparationTargets(workspace, project.name),
    },
    'repo-verify-prepare': {
      command: null,
      dependsOn: verificationTargets(workspace, project),
    },
    'repo-prepare': {
      command: null,
      dependsOn: preparationTargets(workspace, project.name),
    },
  };
  for (const script of SCRIPTS) {
    if (typeof project.scripts[script] !== 'string') continue;
    // Compiler lifecycle hooks rewrite shared contracts/DB outputs. Mark those
    // tasks exclusive; the runner executes every task one at a time.
    const exclusive = project.name === '@supacloud/compiler' && (script === 'build' || script === 'typecheck');
    tasks[`repo-${script.replaceAll(':', '-')}`] = {
      command: ['bun', 'run', script],
      cwd: project.root,
      ...(exclusive ? { exclusive: true } : {}),
      dependsOn: [{ target: 'repo-install', params: 'ignore' }],
    };
  }
  return tasks;
}
