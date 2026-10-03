import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { posix, relative, resolve } from 'node:path';

export const ACCEPTANCE_PROJECT = 'supacloud-workspace-acceptance';
const fields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export const slash = (path) => path.replaceAll('\\', '/');

/** Repository facts, not a scheduler. Installation/workspace membership is unchanged. */
export function readWorkspace(root) {
  root = resolve(root);
  const projects = Object.create(null);
  const byPackage = new Map();
  const byRoot = new Map();
  for (const entry of readdirSync(resolve(root, 'packages'), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error(`Symlinked workspace package requires explicit ownership: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    if (!/^[a-zA-Z0-9._-]+$/.test(entry.name)) throw new Error(`Unsafe package directory: ${entry.name}`);
    const projectRoot = `packages/${entry.name}`;
    const manifestPath = resolve(root, projectRoot, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    const config = readJson(resolve(root, projectRoot, 'project.json'));
    if (!packageName.test(manifest.name ?? '') || !packageName.test(config.name ?? '')) {
      throw new Error(`Invalid package/project name at ${projectRoot}`);
    }
    if (projects[config.name] || byPackage.has(manifest.name) || config.name === ACCEPTANCE_PROJECT) {
      throw new Error(`Duplicate/reserved project identity at ${projectRoot}`);
    }
    if (!Array.isArray(config.tags) || !config.tags.every((tag) => typeof tag === 'string')) {
      throw new Error(`Invalid project tags at ${projectRoot}`);
    }
    const project = {
      name: config.name, packageName: manifest.name, root: projectRoot,
      tags: config.tags, scripts: manifest.scripts ?? {}, manifest,
    };
    projects[project.name] = project;
    byPackage.set(manifest.name, project);
    byRoot.set(projectRoot, project);
  }
  if (!Object.keys(projects).length) throw new Error('No workspace packages found.');
  const edges = [];
  for (const project of Object.values(projects)) {
    // Overrides affect local resolution/build inputs; they are not runtime declarations.
    for (const field of [...fields, 'overrides']) {
      for (const [name, version] of Object.entries(project.manifest[field] ?? {})) {
        if (typeof version !== 'string') {
          if (field === 'overrides') throw new Error(`Nested overrides need an explicit graph adapter: ${project.root}`);
          throw new Error(`Invalid dependency ${name} at ${project.root}`);
        }
        let target = byPackage.get(name);
        const local = /^(file:|link:)/.test(version);
        if (local) {
          const targetRoot = slash(relative(root, resolve(root, project.root, version.replace(/^(file:|link:)/, ''))));
          target = byRoot.get(targetRoot);
          if (!target || target.packageName !== name) {
            throw new Error(`Unresolved/mismatched local dependency ${name}=${version} at ${project.root}`);
          }
        }
        if (target && target.name !== project.name) {
          edges.push({ source: project.name, target: target.name, kind: field, local, sourceFile: `${project.root}/package.json` });
        } else if (target) {
          throw new Error(`Self dependency ${name} at ${project.root}`);
        }
      }
    }
  }
  const policyPath = resolve(root, 'scripts/workspace/policy.json');
  const policy = existsSync(policyPath) ? readJson(policyPath) : { schemaVersion: 1 };
  const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!record(policy)) throw new Error('Invalid workspace policy.');
  for (const key of ['verificationPrerequisites', 'fileInputs']) if (key in policy && !record(policy[key])) throw new Error(`Invalid workspace policy: ${key}`);
  if (policy.schemaVersion !== 1 || Object.keys(policy).some((key) => !['schemaVersion', 'verificationPrerequisites', 'fileInputs', 'cacheBuilds'].includes(key))) throw new Error('Invalid workspace policy.');
  for (const [name, prerequisites] of Object.entries(policy.verificationPrerequisites ?? {})) {
    if (!projects[name] || !Array.isArray(prerequisites) || new Set(prerequisites).size !== prerequisites.length) throw new Error(`Invalid verification prerequisites: ${name}`);
    for (const target of prerequisites) {
      if (!projects[target] || name === target) throw new Error(`Invalid verification prerequisite: ${name} -> ${target}`);
      edges.push({ source: name, target, kind: 'verification', local: false, sourceFile: 'scripts/workspace/policy.json' });
    }
  }
  for (const [name, inputs] of Object.entries(policy.fileInputs ?? {})) {
    if (!projects[name] || !Array.isArray(inputs) || inputs.some((file) => typeof file !== 'string' || !/^packages\/[a-zA-Z0-9._/-]+$/.test(file) || file.split('/').some((part) => !part || part === '.' || part === '..'))) throw new Error(`Invalid generated inputs: ${name}`);
  }
  if ('cacheBuilds' in policy && (!Array.isArray(policy.cacheBuilds) || new Set(policy.cacheBuilds).size !== policy.cacheBuilds.length || policy.cacheBuilds.some((name) => typeof name !== 'string' || typeof projects[name]?.scripts.build !== 'string'))) throw new Error('Invalid cached build policy.');
  const workspace = { root, projects, edges, policy };
  assertAcyclic(workspace);
  return workspace;
}

export function assertAcyclic({ projects, edges }) {
  const active = new Set();
  const visited = new Set();
  const visit = (name, path) => {
    if (active.has(name)) throw new Error(`Workspace dependency cycle: ${[...path, name].join(' -> ')}`);
    if (visited.has(name)) return;
    active.add(name);
    for (const edge of edges.filter((edge) => edge.source === name)) visit(edge.target, [...path, name]);
    active.delete(name);
    visited.add(name);
  };
  for (const name of Object.keys(projects)) visit(name, []);
}

/** Source-only local packages still need installation of their own prerequisites. */
export function preparationTargets(workspace, name, verification = false) {
  return [...new Set(workspace.edges.filter((edge) => edge.source === name && (edge.local || verification && edge.kind === 'verification')).map((edge) => edge.target))]
    .sort().map((name) => ({ projects: [name],
      target: typeof workspace.projects[name].scripts.build === 'string' ? 'repo-build' : 'repo-install', params: 'ignore' }));
}

export function buildPrerequisites(workspace, name) {
  return preparationTargets(workspace, name).filter((entry) => entry.target === 'repo-build').map((entry) => entry.projects[0]);
}

export function resolveProject(workspace, value) {
  const matches = Object.values(workspace.projects).filter((project) =>
    [project.name, project.packageName, project.root, posix.basename(project.root)].includes(value));
  if (matches.length !== 1) throw new Error(`Expected an unambiguous workspace project, received: ${value}`);
  return matches[0];
}

export function ownerOf(workspace, file) {
  return Object.values(workspace.projects).find((project) => file.startsWith(`${project.root}/`));
}

export function graphReport(workspace) {
  return {
    schemaVersion: 1,
    projects: Object.values(workspace.projects).map(({ manifest, ...project }) => ({
      ...project, buildPrerequisites: buildPrerequisites(workspace, project.name), preparationTargets: preparationTargets(workspace, project.name, true),
      fileInputs: workspace.policy?.fileInputs?.[project.name] ?? [],
      cacheBuild: workspace.policy?.cacheBuilds?.includes(project.name) ?? false,
    })),
    edges: workspace.edges,
    acceptance: { name: ACCEPTANCE_PROJECT, dependsOn: Object.keys(workspace.projects).sort(), cache: false },
  };
}

/** Audit-only reverse closure. Never authorizes skipping CI or claims semantic completeness. */
export function affectedReport(workspace, files, fallbackReason) {
  const reasons = new Map();
  const fullReasons = fallbackReason ? [fallbackReason] : [];
  const changedFiles = [...new Set(files.map(slash))].sort();
  for (const file of changedFiles) {
    const owner = ownerOf(workspace, file);
    if (!owner || file.includes('/../') || file.startsWith('../')) {
      fullReasons.push(`Shared, deleted-project, or unowned input: ${file}`);
    } else {
      for (const [consumer, inputs] of Object.entries(workspace.policy?.fileInputs ?? {})) {
        if (inputs.includes(file)) reasons.set(consumer, [...(reasons.get(consumer) ?? []), `Generated input: ${file}`]);
      }
      const current = reasons.get(owner.name) ?? [];
      current.push(`Changed input: ${file}`);
      reasons.set(owner.name, current);
    }
  }
  if (fullReasons.length) {
    for (const name of Object.keys(workspace.projects)) reasons.set(name, [...fullReasons]);
  } else {
    let changed;
    do {
      changed = false;
      for (const edge of workspace.edges) {
        if (reasons.has(edge.target) && !reasons.has(edge.source)) {
          reasons.set(edge.source, [`Depends on ${edge.target} (${edge.kind})`]);
          changed = true;
        }
      }
    } while (changed);
  }
  // Consumer generation is not represented as a runtime package dependency.
  if (reasons.size) reasons.set(ACCEPTANCE_PROJECT, ['Conservative packed/generated-consumer acceptance dependency']);
  return {
    schemaVersion: 1, mode: 'shadow', safeToSkip: false,
    completeness: 'manifest-and-local-resolution-only',
    full: fullReasons.length > 0, fallbackReasons: fullReasons, changedFiles,
    projects: [...reasons].sort(([a], [b]) => a.localeCompare(b)).map(([name, why]) => ({ name, reasons: why })),
  };
}
