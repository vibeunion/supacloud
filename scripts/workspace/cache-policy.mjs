import { createHash } from 'node:crypto';

// Deliberately one reviewed, dependency-free distribution build. Changes to its
// script contract opt out automatically; tests/integrations/install never cache.
export const CONTRACTS_BUILD_SCRIPTS = 'f2fb80e8007a1175cb4d94634d52c8c1e6410af7555b8b3de7d86a917ddcdc06';
export function scriptFingerprint(scripts) {
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(
    Object.entries(scripts).sort(([a], [b]) => a.localeCompare(b)),
  ))).digest('hex');
}
export function buildCachePolicy(project) {
  if (project.packageName !== '@supacloud/contracts' || project.name !== '@supacloud/contracts' ||
      project.root !== 'packages/contracts' || scriptFingerprint(project.scripts) !== CONTRACTS_BUILD_SCRIPTS) {
    return { cache: false };
  }
  return {
    cache: true,
    inputs: ['default', '^default', { runtime: 'node scripts/workspace/cache-key.mjs packages/contracts' }],
    outputs: ['{projectRoot}/dist'],
    metadata: { description: 'Reviewed contracts build: local Nx result cache with full environment/config fingerprint and output-restoration acceptance.' },
  };
}
