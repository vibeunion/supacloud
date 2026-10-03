import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySyncPlan, syncPlan } from './sync.mjs';
import { collectPublicApi, compareSnapshot } from '../check_public_api.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const targets = ['app', 'compiler'];
const args = process.argv.slice(2);
const mode = args[0] ?? '--check';
if (!['--check', '--plan', '--apply-plan'].includes(mode) ||
    (mode === '--apply-plan' ? args.length !== 2 : args.length > 1)) {
  throw new Error('Usage: bun scripts/workspace/sync-public-api.mjs [--check|--plan|--apply-plan PLAN.json]');
}
// Do not snapshot unresolved imports as a new API. These are read-only type checks.
for (const name of targets) {
  const child = spawnSync('bun', ['run', 'typecheck'], { cwd: resolve(root, 'packages', name), stdio: ['ignore', 'pipe', 'pipe'] });
  if (child.error || child.status !== 0) throw new Error(`Prepare ${name}'s locked dependencies and resolve type errors before syncing.\n${child.error?.message ?? `${child.stdout?.toString() ?? ''}\n${child.stderr?.toString() ?? ''}`}`);
}
const outputs = [];
for (const name of targets) {
  const file = `packages/${name}/public-api.json`;
  const snapshot = await collectPublicApi({ packageName: `@supacloud/${name}`, source: resolve(root, `packages/${name}/src/index.ts`), snapshot: resolve(root, file) });
  const actual = JSON.parse(readFileSync(resolve(root, file), 'utf8'));
  outputs.push({ file, content: `${JSON.stringify(snapshot, null, 2)}\n`, summary: compareSnapshot(actual, snapshot) });
}
const report = mode === '--apply-plan'
  ? applySyncPlan(root, JSON.parse(readFileSync(resolve(args[1]), 'utf8')), outputs)
  : syncPlan(root, outputs);
console.log(JSON.stringify(report, null, 2));
if (mode === '--check' && !report.clean) process.exitCode = 1;
