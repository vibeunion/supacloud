import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { checkElysiaCompatibility, parseLockfile } from './check-elysia-compatibility.mjs';

const version = '2.0.0-beta.19';
const templates = [
  'packages/cli/src/shared/tools/advanced-tools.ts',
  'packages/cli/src/shared/tools/app-starter.ts',
  'packages/cli/src/shared/tools/app-starter-templates.ts',
  'packages/compiler/src/migration-policy.ts',
];
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'elysia-compatibility-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const edit = (path, change) => {
    const value = JSON.parse(readFileSync(join(root, path), 'utf8'));
    change(value);
    write(path, value);
  };
  write('package.json', { private: true });
  write('packages/elysia/compatibility.json', {
    bun: '1.4.2', packages: { elysia: version, typebox: '1.3.34', 'exact-mirror': '1.2.6' },
  });
  for (const name of ['app', 'compiler']) {
    write(`packages/${name}/package.json`, { name: `@supacloud/${name}`, dependencies: { typebox: '1.3.34' } });
  }
  const adapter = {
    name: '@supacloud/elysia', dependencies: { typebox: '1.3.34', 'exact-mirror': '1.2.6' },
    peerDependencies: { elysia: version }, devDependencies: { elysia: version },
  };
  write('packages/elysia/package.json', adapter);
  write('packages/elysia/bun.lock', {
    workspaces: { '': adapter }, packages: {
      elysia: [`elysia@${version}`], typebox: ['typebox@1.3.34'], 'exact-mirror': ['exact-mirror@1.2.6'],
    },
  });
  const lite = { name: '@supacloud/lite', devDependencies: { elysia: version } };
  write('packages/supacloud-lite/package.json', lite);
  write('packages/supacloud-lite/bun.lock', {
    workspaces: { '': lite }, packages: {
      elysia: [`elysia@${version}`],
      '@supacloud/elysia': ['@supacloud/elysia@file:../elysia', adapter],
    },
  });
  for (const path of templates) write(path, `export const dependencies = { elysia: "${version}" };\n`);
  return { root, write, edit };
}

test('accepts consistent exact beta declarations without installing dependencies', (t) => {
  assert.deepEqual(checkElysiaCompatibility(fixture(t).root), []);
});
test('parses emitted trailing commas without rewriting strings or evaluating code', () => {
  const expected = { text: 'keep ,} and " ,]', list: [1] };
  const source = JSON.stringify(expected).replace('[1]', '[1,]').replace(/}$/, ',}');
  assert.deepEqual(parseLockfile(source), expected);
  assert.throws(() => parseLockfile('({ injected: process.exit() })'));
});
test('rejects a widened beta peer', (t) => {
  const f = fixture(t);
  f.edit('packages/elysia/package.json', (p) => { p.peerDependencies.elysia = '>=2.0.0-beta.19 <3'; });
  assert.match(checkElysiaCompatibility(f.root).join('\n'), /peerDependencies\.elysia must equal/);
});
test('rejects stale adapter workspace lock metadata', (t) => {
  const f = fixture(t);
  f.edit('packages/elysia/bun.lock', (p) => { p.workspaces[''].peerDependencies.elysia = '>=2.0.0-beta.19 <3'; });
  assert.match(checkElysiaCompatibility(f.root).join('\n'), /stale workspace peerDependencies\.elysia/);
});
test('rejects stale copied adapter metadata in a consumer lockfile', (t) => {
  const f = fixture(t);
  f.edit('packages/supacloud-lite/bun.lock', (p) => {
    p.packages['@supacloud/elysia'][1].peerDependencies.elysia = '>=2.0.0-beta.19 <3';
  });
  assert.match(checkElysiaCompatibility(f.root).join('\n'), /stale local @supacloud\/elysia peer metadata/);
});
test('rejects an incorrect resolved version and a missing direct-consumer lock', (t) => {
  const f = fixture(t);
  f.edit('packages/elysia/bun.lock', (p) => { p.packages.elysia[0] = 'elysia@1.4.30'; });
  assert.match(checkElysiaCompatibility(f.root).join('\n'), /resolved Elysia version/);
  rmSync(join(f.root, 'packages/elysia/bun.lock'));
  assert.match(checkElysiaCompatibility(f.root).join('\n'), /missing lockfile/);
});
test('rejects direct, plugin and aliased framework dependencies in core packages', (t) => {
  for (const [name, spec] of [['elysia', version], ['@elysia/openapi', '2.0.0-beta.4'],
    ['@supacloud/elysia', 'file:../elysia'], ['http-framework', `npm:elysia@${version}`]]) {
    const f = fixture(t);
    f.edit('packages/app/package.json', (p) => { p.dependencies[name] = spec; });
    assert.match(checkElysiaCompatibility(f.root).join('\n'), /couples the application\/compiler package/);
  }
});
test('checks newly added repository-owned consumers without an allowlist', (t) => {
  const f = fixture(t);
  f.write('packages/new-runtime/package.json', { name: '@supacloud/new-runtime', dependencies: { elysia: '^1.4.30' } });
  assert.match(checkElysiaCompatibility(f.root).join('\n'), /new-runtime\/package\.json: dependencies\.elysia/);
});
test('checks each scaffold and migration policy independently', (t) => {
  for (const path of templates) {
    const f = fixture(t);
    f.write(path, 'export const dependencies = { elysia: "^1.4.30" };');
    assert.ok(checkElysiaCompatibility(f.root).some((message) => message.startsWith(path)));
  }
});
test('rejects a legacy-only schema matrix and mismatched active schema declarations', (t) => {
  const f = fixture(t);
  f.edit('packages/elysia/compatibility.json', (p) => { delete p.packages.typebox; p.packages['@sinclair/typebox'] = '0.34.52'; });
  assert.match(checkElysiaCompatibility(f.root).join('\n'), /active typebox version/);
});
test('rejects an unpinned compatibility target', (t) => {
  const f = fixture(t);
  f.edit('packages/elysia/compatibility.json', (p) => { p.packages.elysia = '^2.0.0-beta.19'; });
  assert.match(checkElysiaCompatibility(f.root).join('\n'), /exact Elysia 2\.0 beta version/);
});
test('does not rewrite historical third-party adapter dependencies', (t) => {
  const f = fixture(t);
  f.write('packages/third-party-consumer/package.json', { name: '@supacloud/third-party-consumer' });
  f.write('packages/third-party-consumer/bun.lock', { packages: {
    '@supacloud/elysia': ['@supacloud/elysia@0.10.0', '', { peerDependencies: { elysia: '^1.4.30' } }, 'integrity'],
  } });
  assert.deepEqual(checkElysiaCompatibility(f.root), []);
});

test('rejects a missing core manifest rather than silently reducing coverage', (t) => {
  const f = fixture(t);
  rmSync(join(f.root, 'packages/app/package.json'));
  assert.match(checkElysiaCompatibility(f.root).join('\n'), /missing required framework manifest/);
});
test('checks the resolved active schema tuple, not only declared versions', (t) => {
  const f = fixture(t);
  f.edit('packages/elysia/bun.lock', (p) => { p.packages.typebox[0] = 'typebox@1.3.33'; });
  assert.match(checkElysiaCompatibility(f.root).join('\n'), /resolved typebox must match compatibility.json/);
});

test('rejects stale direct and nested local schema snapshots in the adapter lock', (t) => {
  for (const name of ['app', 'compiler', 'delivery', 'compiler/@supacloud/delivery']) {
    const f = fixture(t);
    const localName = name.split('/').at(-1);
    f.edit('packages/elysia/bun.lock', (p) => {
      p.packages[`@supacloud/${name}`] = [
        `@supacloud/${localName}@file:../${localName}`,
        { dependencies: { '@sinclair/typebox': '^0.34.52' } },
      ];
    });
    assert.match(checkElysiaCompatibility(f.root).join('\n'), /stale local schema metadata/);
  }
});

test('accepts current local schema snapshots', (t) => {
  const f = fixture(t);
  f.edit('packages/elysia/bun.lock', (p) => {
    p.packages['@supacloud/app'] = [
      '@supacloud/app@file:../app', { dependencies: { typebox: '1.3.34' } },
    ];
    p.packages['@supacloud/compiler/@supacloud/delivery'] = [
      '@supacloud/delivery@file:../delivery', {},
    ];
  });
  assert.deepEqual(checkElysiaCompatibility(f.root), []);
});

test('rejects stale populated schema snapshots in the Lite consumer lock', (t) => {
  for (const name of ['app', 'compiler', 'delivery']) {
    const f = fixture(t);
    f.edit('packages/supacloud-lite/bun.lock', (p) => {
      p.packages[`@supacloud/elysia/@supacloud/${name}`] = [
        `@supacloud/${name}@file:../${name}`,
        { dependencies: { '@sinclair/typebox': '^0.34.52' } },
      ];
    });
    assert.match(checkElysiaCompatibility(f.root).join('\n'), /stale local schema metadata/);
  }
});

test('rejects mixed legacy and active schema dependencies in populated snapshots', (t) => {
  for (const directory of ['elysia', 'supacloud-lite']) {
    const f = fixture(t);
    f.edit(`packages/${directory}/bun.lock`, (p) => {
      p.packages['@supacloud/app'] = ['@supacloud/app@file:../app', {
        dependencies: { typebox: '1.3.34', '@sinclair/typebox': '^0.34.52' },
      }];
    });
    assert.match(checkElysiaCompatibility(f.root).join('\n'), /stale local schema metadata/);
  }
});

test('distinguishes missing schema dependencies from empty Bun deduplication placeholders', (t) => {
  for (const directory of ['elysia', 'supacloud-lite']) {
    const f = fixture(t);
    f.edit(`packages/${directory}/bun.lock`, (p) => {
      p.packages['@supacloud/compiler'] = ['@supacloud/compiler@file:../compiler', {
        devDependencies: { typescript: '^7.0.2' },
      }];
    });
    assert.match(checkElysiaCompatibility(f.root).join('\n'), /stale local schema metadata/);
    f.edit(`packages/${directory}/bun.lock`, (p) => { p.packages['@supacloud/compiler'][1] = {}; });
    assert.deepEqual(checkElysiaCompatibility(f.root), []);
  }
});
