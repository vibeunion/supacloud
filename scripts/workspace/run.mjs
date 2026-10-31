import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readWorkspace, resolveProject } from './model.mjs';
import { taskPlan } from './tasks.mjs';

/**
 * Run one repository task after its local prerequisites.
 *
 * `bun --filter` needs one Bun workspace. These packages keep independent
 * lockfiles, and verification edges are not package dependencies, so ordering
 * walks the existing file:/link: graph and then runs Bun in each package.
 * Tasks run one at a time: a compiler lifecycle hook cannot overlap a consumer
 * reading the same outputs, and Windows installs cannot race the shared cache.
 * There is no result cache; every selected command runs.
 */
export function runTask(root, selector, task) {
  const workspace = readWorkspace(root);
  const project = resolveProject(workspace, selector);
  execute(workspace, project.name, task, new Map());
}

function execute(workspace, name, task, state) {
  const id = `${name}:${task}`;
  const current = state.get(id);
  if (current === 'done') return;
  if (current === 'active') throw new Error(`Workspace task cycle: ${id}`);
  const spec = taskPlan(workspace, workspace.projects[name])[task];
  if (!spec) throw new Error(`Missing workspace task: ${id}`);
  state.set(id, 'active');
  for (const dependency of spec.dependsOn ?? []) {
    for (const projectName of dependency.projects ?? [name]) {
      execute(workspace, projectName, dependency.target, state);
    }
  }
  if (spec.command) {
    const cwd = resolve(workspace.root, spec.cwd);
    process.stderr.write(`workspace ${id}\n`);
    const result = spawnSync(spec.command[0], spec.command.slice(1), { cwd, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Workspace task failed: ${id} (${result.signal ?? result.status})`);
  }
  state.set(id, 'done');
}
