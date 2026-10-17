import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateReleaseIdentity } from './validate-release-identity.mjs';

const path = 'packages/supacloud-lite';
const config = { packages: { [path]: { component: 'supacloud-lite' } } };
test('Lite permits the exact manifest, package and release tag identity', () => {
  validateReleaseIdentity(path, '0.30.0', config, '0.30.0', 'supacloud-lite-v0.30.0');
});
for (const [version, packageVersion, tag] of [
  ['0.30.0', '0.30.0', 'supacloud-lite-v0.29.6'],
  ['0.29.6', '0.30.0', 'supacloud-lite-v0.29.6'],
  ['0.30.0', '0.30.0', 'cli-v0.30.0'],
  ['0.30.0', '0.30.0', undefined],
  ['0.30.0\ninjection', '0.30.0', 'supacloud-lite-v0.30.0'],
]) {
  test(`Lite refuses inconsistent identity ${JSON.stringify([version, packageVersion, tag])}`, () => {
    assert.throws(() => validateReleaseIdentity(path, version, config, packageVersion, tag));
  });
}
test('Lite guard runs before build, attestation and upload using the selected tag', () => {
  const workflow = readFileSync(new URL('../workflows/release-please.yml', import.meta.url), 'utf8');
  const lite = workflow.slice(workflow.indexOf('  publish-supacloud-lite-binaries:'), workflow.indexOf('  publish-npm:'));
  const guard = lite.indexOf('run: node .github/scripts/validate-release-identity.mjs');
  assert.ok(guard > 0);
  assert.match(lite.slice(0, guard), /RELEASE_TAG: \$\{\{ needs.release-please.outputs.supacloud_lite_tag_name \}\}/);
  for (const step of ['Build standalone release matrix', 'Attest SupaCloud Lite', 'Upload standalone artifacts']) {
    assert.ok(lite.indexOf(step) > guard);
  }
});
