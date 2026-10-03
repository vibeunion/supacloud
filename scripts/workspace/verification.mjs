import { preparationTargets, resolveProject } from './model.mjs';

// Verification-only consumers not expressed by production package dependencies.
// Do not turn these into runtime dependencies or add them to repo-build.
const additional = {
  '@supacloud/compiler': ['contracts'],
  '@supacloud/db': ['commands', 'compiler'],
  '@supacloud/lite': ['supacloud-js'],
};
export function verificationTargets(workspace, project) {
  const result = [{ target: 'repo-prepare', params: 'ignore' }];
  for (const alias of additional[project.name] ?? []) {
    const dependency = resolveProject(workspace, alias);
    result.push({ projects: [dependency.name], target: 'repo-build', params: 'ignore' });
  }
  return result;
}

/** Serializable task relations; not a second task scheduler. */
export function verificationRelations(workspace) {
  return Object.values(workspace.projects).map((project) => ({
    project: project.name, prepare: preparationTargets(workspace, project.name),
    verify: verificationTargets(workspace, project),
  }));
}
