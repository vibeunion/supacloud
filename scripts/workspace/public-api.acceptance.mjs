import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCommandPackage } from '../../.github/scripts/prepare-command-package.mjs';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const temp = mkdtempSync(resolve(tmpdir(), 'supacloud-public-api-'));
const consumer = resolve(temp, 'consumer');
const run = (cmd, args, cwd = consumer) => execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
try {
  const manifests = ['delivery', 'cli'].map((name) => JSON.parse(readFileSync(resolve(repo, 'packages', name, 'package.json'), 'utf8')));
  const siblings = new Map(manifests.map((manifest) => [manifest.name, manifest]));
  const tarballs = [];
  for (const [index, name] of ['delivery', 'cli'].entries()) {
    const stage = resolve(temp, 'staging', name);
    mkdirSync(stage, { recursive: true });
    for (const directory of ['src', 'dist']) cpSync(resolve(repo, 'packages', name, directory), resolve(stage, directory), { recursive: true });
    const manifest = prepareCommandPackage(manifests[index], siblings).package;
    // Only dependency development references are rewritten, exactly as in release packaging.
    writeFileSync(resolve(stage, 'package.json'), JSON.stringify(manifest));
    const tarball = resolve(temp, `${name}.tgz`);
    run('bun', ['pm', 'pack', '--ignore-scripts', '--filename', tarball], stage);
    tarballs.push(tarball);
  }
  rmSync(resolve(temp, 'staging'), { recursive: true });
  mkdirSync(consumer);
  writeFileSync(resolve(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--registry=https://registry.npmjs.org', ...tarballs, '@types/bun@1.4.2', '@typescript/typescript6@6.0.2']);
  const checks = `import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {schemaEnumValues,stringEnum} from '@supacloud/cli/schema';
import {registerGatewayTools} from '@supacloud/cli/gateway-tools';
import {listFrontendReleases} from '@supacloud/cli/frontend-release-control';
import {projectEndpointRead} from '@supacloud/cli/project-endpoint-read';
import {projectGetRead} from '@supacloud/cli/project-read-projection';
import {releaseTag} from '@supacloud/delivery/platform-release-manifest';
import {buildUpgradeLockScript} from '@supacloud/delivery/platform-upgrade-lock';
import {SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_JSONL,SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SHA256} from '@supacloud/delivery/platform-sigstore-trusted-root';
assert.deepEqual(schemaEnumValues(stringEnum(['first','second'])),['first','second']);
for(const value of [registerGatewayTools,listFrontendReleases,projectEndpointRead,projectGetRead]) assert.equal(typeof value,'function');
assert.equal(releaseTag('management-api','1.2.3'),'management-api-v1.2.3');
assert.ok(buildUpgradeLockScript('/tmp/fixture.lock').includes('flock -E 75 -n 9'));
assert.equal(createHash('sha256').update(SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_JSONL).digest('hex'),SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SHA256);
const require=createRequire(import.meta.url);
assert.ok(require.resolve('@supacloud/cli').endsWith('/dist/index.js'));
assert.ok(require.resolve('@supacloud/cli/package.json').endsWith('/package.json'));
assert.ok(existsSync(new URL('./node_modules/@supacloud/cli/src/shared/schema.ts', import.meta.url)));
assert.throws(()=>require.resolve('@supacloud/cli/src/shared/schema.ts'),{code:process.versions.bun ? 'MODULE_NOT_FOUND' : 'ERR_PACKAGE_PATH_NOT_EXPORTED'});
`;
  writeFileSync(resolve(consumer, 'check.mjs'), checks);
  run('node', ['check.mjs']); run('bun', ['--no-env-file', 'check.mjs']);
  writeFileSync(resolve(consumer, 'browser.ts'), `import {parseDevelopmentContext} from '@supacloud/delivery/development'; export {parseDevelopmentContext};`);
  run('bun', ['build', 'browser.ts', '--target', 'browser', '--outfile', 'browser.mjs']);
  assert.ok(!/from ["'](?:node:|bun)/.test(readFileSync(resolve(consumer, 'browser.mjs'), 'utf8')));
  writeFileSync(resolve(consumer, 'consumer.ts'), `
import {stringEnum, type ToolSchema} from '@supacloud/cli/schema';
import {type ReleaseManifest, releaseTag} from '@supacloud/delivery/platform-release-manifest';
import {type SupaCloudUpgradeLock} from '@supacloud/delivery/platform-upgrade-lock';
import {SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_JSONL} from '@supacloud/delivery/platform-sigstore-trusted-root';
import {type DevelopmentContext} from '@supacloud/delivery/development';
const schema: ToolSchema = { command: stringEnum(['check']) };
const text: string = SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_JSONL;
// @ts-expect-error Invalid platform component must be rejected.
releaseTag('invalid', '1.0.0');
void [schema, text];
export type PublicTypes = [ReleaseManifest, SupaCloudUpgradeLock, DevelopmentContext];
`);
  run('node', ['--input-type=module', '-e', `import ts from '@typescript/typescript6';
const p=ts.createProgram(['consumer.ts'],{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,strict:true,skipLibCheck:true,noEmit:true,types:['bun']});
const d=ts.getPreEmitDiagnostics(p);if(d.length)throw new Error(ts.formatDiagnosticsWithColorAndContext(d,{getCanonicalFileName:p=>p,getCurrentDirectory:()=>process.cwd(),getNewLine:()=>"\\n"}));`]);
  for (const name of ['delivery', 'cli']) {
    const installed = JSON.parse(readFileSync(resolve(consumer, `node_modules/@supacloud/${name}/package.json`), 'utf8'));
    assert.equal(installed.dependencies?.nx, undefined);
    assert.ok(existsSync(resolve(consumer, `node_modules/@supacloud/${name}/dist/index.js`)));
  }
  console.log('PASS: actual packed public APIs in isolated npm consumer; Node/Bun exports, public types, browser-safe development contract, pinned trust root, CLI root resolution and private import rejection.');
} finally { rmSync(temp, { recursive: true, force: true }); }
