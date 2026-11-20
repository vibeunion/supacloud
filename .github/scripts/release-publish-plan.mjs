/**
 * Structural reader and checker for the release publish graph.
 *
 * The npm publication job is a single sequential job whose correctness lives in
 * YAML indentation: which package publishes first, which `*_released` output
 * gates it, which earlier step it waits for, and whether it authenticates with
 * OIDC or the bootstrap token. Probing that with `source.indexOf('- name: ...')`
 * and `slice()` breaks on any comment or indentation change, so this module
 * reads the job into plain step objects instead.
 *
 * Only the narrow YAML subset used by `.github/workflows/release-please.yml` is
 * supported. Anything outside it (anchors, merge keys, flow collections,
 * non-literal block scalars) raises instead of silently producing a wrong graph.
 */

const JOB_HEADER = /^ {2}([A-Za-z0-9_-]+):[ \t]*$/;
const STEP_ITEM = /^ {6}-[ \t]+(.*)$/;
const STEP_KEY = /^ {8}([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/;
const CHILD_KEY = /^ {10}([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/;

/** @typedef {{ name?: string, id?: string, if?: string, 'working-directory'?: string, 'continue-on-error'?: string, run?: string, env: Record<string, string> }} WorkflowStep */

function unsupported(lineNumber, detail) {
  throw new Error(`unsupported workflow YAML at line ${lineNumber}: ${detail}`);
}

/** @param {string} value */
function scalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    return { flow: trimmed };
  }
  if (trimmed.startsWith('&') || trimmed.startsWith('*') || trimmed.startsWith('<<')) {
    return { flow: trimmed };
  }
  const quoted = /^(['"])([\s\S]*)\1$/.exec(trimmed);
  return { text: quoted ? quoted[2] : trimmed };
}

/**
 * @param {string} source
 * @param {string} jobName
 */
function jobSection(source, jobName) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  if (start < 0) throw new Error(`workflow has no job named ${jobName}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (JOB_HEADER.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).map((line, offset) => ({ line, lineNumber: start + offset + 2 }));
}

/**
 * @param {{ line: string, lineNumber: number }[]} section
 * @param {string} blockName
 */
function blockLines(section, blockName) {
  const header = section.findIndex((entry) => entry.line.trimEnd() === `    ${blockName}:`);
  if (header < 0) return [];
  const entries = [];
  for (let index = header + 1; index < section.length; index += 1) {
    const { line, lineNumber } = section[index];
    if (line.trim() === '') continue;
    if (!line.startsWith('      ')) break;
    entries.push({ line, lineNumber });
  }
  return entries;
}

/** @param {string} source @param {string} jobName */
export function readJobOutputs(source, jobName) {
  const outputs = {};
  for (const { line, lineNumber } of blockLines(jobSection(source, jobName), 'outputs')) {
    const match = /^ {6}([A-Za-z0-9_-]+):[ \t]+(.*)$/.exec(line);
    if (!match) unsupported(lineNumber, 'expected "<name>: <expression>" under outputs');
    const value = scalar(match[2]);
    if (value.flow !== undefined) unsupported(lineNumber, 'flow collection or anchor in outputs');
    outputs[match[1]] = value.text;
  }
  return outputs;
}

/**
 * @param {string} source
 * @param {string} jobName
 * @returns {WorkflowStep[]}
 */
export function readJobSteps(source, jobName) {
  /** @type {WorkflowStep[]} */
  const steps = [];
  /** @type {WorkflowStep | null} */
  let current = null;
  /** @type {string | null} */
  let activeKey = null;
  /** @type {Record<string, string> | null} */
  let activeChildren = null;
  /** @type {string[] | null} */
  let activeBlock = null;

  const flushBlock = () => {
    if (current && activeKey && activeBlock) {
      const key = activeKey;
      const value = activeBlock.join('\n');
      if (key === 'run') current.run = value;
      else /** @type {Record<string, unknown>} */ (current)[key] = value;
    }
    activeBlock = null;
  };

  const consumeKey = (key, rawValue, lineNumber) => {
    if (!current) unsupported(lineNumber, 'step key outside a step');
    if (rawValue === undefined || rawValue === '') {
      activeKey = key;
      activeChildren = {};
      /** @type {Record<string, unknown>} */ (current)[key] = key === 'env' ? current.env : {};
      return;
    }
    if (rawValue === '|' || rawValue === '>') {
      if (rawValue === '>') unsupported(lineNumber, 'folded block scalar is not supported');
      activeKey = key;
      activeChildren = null;
      activeBlock = [];
      return;
    }
    const value = scalar(rawValue);
    if (value.flow !== undefined) unsupported(lineNumber, `flow collection or anchor: ${value.flow}`);
    activeKey = key;
    activeChildren = null;
    /** @type {Record<string, unknown>} */ (current)[key] = value.text;
  };

  for (const { line, lineNumber } of blockLines(jobSection(source, jobName), 'steps')) {
    const item = STEP_ITEM.exec(line);
    if (item) {
      flushBlock();
      current = { env: {} };
      steps.push(current);
      activeKey = null;
      activeChildren = null;
      activeBlock = null;
      const inlineKey = STEP_KEY.exec(`        ${item[1]}`);
      if (inlineKey) consumeKey(inlineKey[1], inlineKey[2], lineNumber);
      else unsupported(lineNumber, 'step must start with "key: value"');
      continue;
    }
    if (!current) unsupported(lineNumber, 'continuation line before the first step');
    if (activeBlock) {
      activeBlock.push(line.replace(/^ {10}/, ''));
      continue;
    }
    if (line.trimStart().startsWith('#')) continue;
    const key = STEP_KEY.exec(line);
    if (key) {
      flushBlock();
      consumeKey(key[1], key[2], lineNumber);
      continue;
    }
    const child = CHILD_KEY.exec(line);
    if (child && activeChildren) {
      const value = scalar(child[2] ?? '');
      if (value.flow !== undefined) unsupported(lineNumber, 'flow collection or anchor under a step key');
      activeChildren[child[1]] = value.text;
      if (activeKey === 'env') current.env[child[1]] = value.text;
      continue;
    }
    unsupported(lineNumber, 'unrecognised indentation or construct');
  }
  flushBlock();
  return steps;
}

const AUTH_TOKEN_ENV_KEYS = ['NODE_AUTH_TOKEN', 'NPM_TOKEN'];

/**
 * @param {WorkflowStep} step
 * @param {string} gate
 */
function stepProblems(step, gate) {
  const problems = [];
  const condition = step.if ?? '';
  const name = step.name ?? '<unnamed step>';
  if (!condition.includes(`needs.release-please.outputs.${gate} == 'true'`)) {
    problems.push(`${name}: if: does not gate on needs.release-please.outputs.${gate} == 'true'`);
  }
  if (step['continue-on-error'] === 'true') {
    problems.push(`${name}: continue-on-error must not hide a failed publication`);
  }
  return problems;
}

/**
 * Read one scalar job key such as `if:` or `needs:`. Nested blocks are skipped.
 *
 * @param {string} source
 * @param {string} jobName
 * @param {string} key
 */
export function readJobScalar(source, jobName, key) {
  const pattern = new RegExp(`^ {4}${key}:[ \\t]+(.+)$`);
  for (const { line } of jobSection(source, jobName)) {
    const match = pattern.exec(line);
    if (match) return scalar(match[1]).text;
  }
  return undefined;
}

/**
 * @param {WorkflowStep} step
 * @param {{ auth: string, provenance: boolean }} planned
 */
function authenticationProblems(step, planned) {
  const problems = [];
  const name = step.name ?? '<unnamed step>';
  const tokenKeys = [...AUTH_TOKEN_ENV_KEYS, 'NPM_BOOTSTRAP_TOKEN'].filter((key) => key in step.env);
  if (planned.auth === 'oidc') {
    if (tokenKeys.length > 0) {
      problems.push(`${name}: OIDC publication must not pass ${tokenKeys.join(', ')}`);
    }
    if (step.env.SUPACLOUD_NPM_PUBLISH_IGNORE_PROVENANCE === '1') {
      problems.push(`${name}: OIDC publication must keep provenance enabled`);
    }
    return problems;
  }
  if (planned.auth !== 'bootstrap-token') {
    problems.push(`${name}: unknown auth mode ${planned.auth}`);
    return problems;
  }
  const token = step.env.NODE_AUTH_TOKEN ?? '';
  if (!token.includes('NPM_BOOTSTRAP_TOKEN')) {
    problems.push(`${name}: bootstrap publication must read secrets.NPM_BOOTSTRAP_TOKEN`);
  }
  const ignoresProvenance = step.env.SUPACLOUD_NPM_PUBLISH_IGNORE_PROVENANCE === '1';
  if (ignoresProvenance === planned.provenance) {
    problems.push(
      `${name}: SUPACLOUD_NPM_PUBLISH_IGNORE_PROVENANCE must be set exactly when provenance is false`,
    );
  }
  return problems;
}

/**
 * @param {WorkflowStep} step
 * @param {string[]} requires
 * @param {Map<string, string>} declaredIds
 */
function dependencyProblems(step, requires, declaredIds) {
  const problems = [];
  const name = step.name ?? '<unnamed step>';
  const condition = step.if ?? '';
  const referenced = [...condition.matchAll(/steps\.([A-Za-z0-9_-]+)\.outcome/g)].map((match) => match[1]);
  for (const required of requires) {
    if (!declaredIds.has(required)) {
      problems.push(`${name}: requires ${required}, which is not an earlier publish step`);
      continue;
    }
    if (!referenced.includes(required)) {
      problems.push(`${name}: if: does not wait for ${required}`);
    }
  }
  for (const reference of new Set(referenced)) {
    if (!requires.includes(reference)) {
      problems.push(`${name}: if: waits for ${reference}, which the plan does not declare`);
    }
  }
  return problems;
}

/**
 * Compare the workflow with the declared publish plan.
 *
 * @param {{
 *   source: string,
 *   plan: {
 *     job: string,
 *     outputsJob?: string,
 *     steps: {
 *       name: string,
 *       packageDir: string,
 *       gate: string,
 *       auth: 'oidc' | 'bootstrap-token',
 *       provenance: boolean,
 *       requires?: string[],
 *     }[],
 *   },
 *   readPackageJson?: (directory: string) => Record<string, unknown> | undefined,
 * }} input
 * @returns {string[]} problems; empty when the workflow matches the plan
 */
export function checkPublishPlan({ source, plan, readPackageJson }) {
  const problems = [];
  const outputsJob = plan.outputsJob ?? 'release-please';
  const outputs = readJobOutputs(source, outputsJob);
  const workflowSteps = readJobSteps(source, plan.job)
    .filter((step) => (step.name ?? '').startsWith('Publish'));

  if (workflowSteps.length !== plan.steps.length) {
    problems.push(
      `${plan.job}: ${workflowSteps.length} publish steps in the workflow, ${plan.steps.length} in the plan`,
    );
  }

  /** @type {Map<string, string>} */
  const declaredIds = new Map();
  for (const [index, planned] of plan.steps.entries()) {
    const step = workflowSteps[index];
    if (!step) {
      problems.push(`${planned.name}: missing from ${plan.job}`);
      continue;
    }
    if (step.name !== planned.name) {
      problems.push(`${planned.name}: expected at position ${index + 1}, found ${step.name}`);
      continue;
    }
    if (!(planned.gate in outputs)) {
      problems.push(`${planned.name}: gate ${planned.gate} is not a ${outputsJob} output`);
    }
    problems.push(...stepProblems(step, planned.gate));
    if (step['working-directory'] !== planned.packageDir) {
      problems.push(`${planned.name}: working-directory must be ${planned.packageDir}`);
    }
    problems.push(...authenticationProblems(step, planned));
    problems.push(...dependencyProblems(step, planned.requires ?? [], declaredIds));
    if (readPackageJson) {
      const manifest = readPackageJson(planned.packageDir);
      if (!manifest) problems.push(`${planned.name}: ${planned.packageDir}/package.json is missing`);
      else if (typeof manifest.name !== 'string'
        || !(manifest.name.startsWith('@supacloud/') || manifest.name === 'supacloud')) {
        problems.push(`${planned.name}: ${planned.packageDir} is not a SupaCloud package`);
      }
    }
    if (step.id) declaredIds.set(step.id, planned.name);
  }
  return problems;
}