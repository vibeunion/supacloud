import { test } from "node:test";
import assert from "node:assert/strict";
import type { SQL } from "bun";
import {
  parseProjectS3Settings, parseStoredProjectS3, assertProjectS3Origin, publicProjectStorage,
  sameStorageNamespace, overlappingStorageNamespace, ProjectStorageError, type ProjectS3Configuration,
} from "../../src/services/project-storage-contract";
import { ProjectS3Driver, type ProjectS3Client } from "../../src/services/project-s3-driver";
import { ProjectStorageRouter } from "../../src/services/project-storage-router";
import { createProjectStorageRegistry } from "../../src/services/project-storage-registry";
import type { StorageDriver } from "../../src/services/storage.adapter";

const settings = (suffix = 'a') => ({
  endpoint: `https://s3-${suffix}.example.test`, region: 'us-east-2', bucket: `project-${suffix}-assets`,
  prefix: '', virtualHostedStyle: false, accessKeyId: `key-${suffix}`, secretAccessKey: `secret-${suffix}`, enabled: true,
});
const configuration = (ref = 'projecta', suffix = 'a'): ProjectS3Configuration => ({
  ...parseProjectS3Settings(settings(suffix)), projectRef: ref, version: 1, revision: crypto.randomUUID(),
});

function memoryClient() {
  const values = new Map<string, { bytes: Uint8Array; type: string }>();
  const calls: { action: string; key: string }[] = [];
  let failure = false;
  const check = () => { if (failure) throw new Error('AccessDenied: secret-do-not-leak'); };
  const client: ProjectS3Client = {
    async list(input) {
      check(); calls.push({ action: 'list', key: input.prefix });
      const keys = [...values.keys()].filter((key) => key.startsWith(input.prefix)).sort();
      const offset = Number(input.continuationToken ?? 0);
      const take = Math.min(input.maxKeys ?? 2, 2);
      const selected = keys.slice(offset, offset + take);
      return { contents: selected.map((key) => ({ key, size: values.get(key)!.bytes.length })),
        isTruncated: offset + take < keys.length,
        ...(offset + take < keys.length ? { nextContinuationToken: String(offset + take) } : {}) };
    },
    file(key) {
      return {
        async stat() { check(); return { type: values.get(key)!.type }; },
        async exists() { check(); calls.push({ action: 'exists', key }); return values.has(key); },
        async arrayBuffer() { check(); return Uint8Array.from(values.get(key)!.bytes).buffer; },
        async write(bytes, options) { check(); calls.push({ action: 'write', key }); values.set(key, { bytes: Uint8Array.from(bytes), type: options.type }); },
        async delete() { check(); calls.push({ action: 'delete', key }); values.delete(key); },
        presign() { check(); return `https://signed.example.test/${key}?signature=test`; },
      };
    },
  };
  return { client, values, calls, fail: () => { failure = true; } };
}

function fixture() {
  const stored = new Map<string, string>();
  const sealed = new Map<string, string>();
  const projects = new Map([['projecta', 'db_a'], ['projectb', 'db_b'], ['projectc', 'db_c']]);
  const occupied = new Set<string>();
  const uploads = new Set<string>();
  const queries: string[] = [];
  const clients = new Map<string, ReturnType<typeof memoryClient>>();
  let databaseFailure = false;
  let origins = 'https://s3-a.example.test,https://s3-b.example.test';
  const query = async (strings: TemplateStringsArray, ...args: unknown[]) => {
    if (databaseFailure) throw new Error('database error: secret-do-not-leak');
    const text = strings.join('?'); queries.push(text);
    if (text.includes('pg_advisory')) return [];
    if (text.includes('SELECT ref, db_name')) return projects.has(String(args[0])) ? [{ ref: args[0], db_name: projects.get(String(args[0])) }] : [];
    if (text.includes('SELECT value_encrypted')) return stored.has(String(args[0])) ? [{ value_encrypted: stored.get(String(args[0])) }] : [];
    if (text.includes('SELECT project_ref, value_encrypted')) return [...stored].filter(([ref]) => ref !== args[2]).map(([project_ref, value_encrypted]) => ({ project_ref, value_encrypted }));
    if (text.includes('system_tus_uploads')) return [{ occupied: uploads.has(String(args[0])) }];
    if (text.includes('INSERT INTO project_control_secrets')) { stored.set(String(args[0]), String(args[3])); return []; }
    throw new Error(`Unexpected query: ${text}`);
  };
  const database = Object.assign(query, {
    async begin<T>(callback: (transaction: SQL) => Promise<T>): Promise<T> {
      const before = new Map(stored);
      try { return await callback(database as unknown as SQL); }
      catch (error) { stored.clear(); for (const [key, value] of before) stored.set(key, value); throw error; }
    },
  });
  const registry = createProjectStorageRegistry({
    database: database as unknown as SQL,
    getProjectDb: (name) => (async () => [{ occupied: occupied.has(name) }]) as unknown as SQL,
    encryptSecret(value) { const ciphertext = `sealed-${crypto.randomUUID()}`; sealed.set(ciphertext, value); return ciphertext; },
    decryptSecret(value) { const plaintext = sealed.get(value); if (!plaintext) throw new Error('Invalid encrypted secret'); return plaintext; },
    allowedOrigins: () => origins, defaultBackend: () => 'local',
    createDriver(config) {
      let client = clients.get(config.projectRef);
      if (!client) { client = memoryClient(); clients.set(config.projectRef, client); }
      return new ProjectS3Driver(config, client.client);
    },
    async probe() { return { backend: 's3', reachable: true, listable: true, writable: 'not_tested' }; },
  });
  return { registry, stored, occupied, uploads, queries, clients,
    failDatabase: () => { databaseFailure = true; }, revokeOrigins: () => { origins = ''; } };
}

const unavailable = (error: unknown) => error instanceof ProjectStorageError && error.statusCode === 503 && !error.message.includes('secret-do-not-leak');
const conflict = (error: unknown) => error instanceof ProjectStorageError && error.statusCode === 409;

test('normalizes a project binding and requires an exact operator-approved origin', () => {
  const input = parseProjectS3Settings({ ...settings(), endpoint: 'https://s3-a.example.test/', prefix: 'tenants/a' });
  assert.equal(input.endpoint, 'https://s3-a.example.test'); assert.equal(input.prefix, 'tenants/a/');
  assert.equal(input.region, 'us-east-2'); assert.ok(Object.isFrozen(input));
  assertProjectS3Origin(input, 'https://s3-a.example.test');
  assert.throws(() => assertProjectS3Origin(input, 'https://*.example.test'), unavailable);
});

test('rejects credential-bearing URLs, endpoint paths, unsafe prefixes and incomplete credentials', () => {
  for (const endpoint of ['https://user:secret@s3.example.test', 'https://s3.example.test/path', 'https://s3.example.test/?key=x', 'https://s3.example.test/#fragment', 'file:///tmp/bucket']) {
    assert.throws(() => parseProjectS3Settings({ ...settings(), endpoint }));
  }
  for (const prefix of ['/', '/other/', 'a/../b', 'a//b', 'a\\b', './', 'a/\0']) assert.throws(() => parseProjectS3Settings({ ...settings(), prefix }));
  assert.throws(() => parseProjectS3Settings({ ...settings(), secretAccessKey: '' }));
});

test('stored configuration is bound to its project and never exposes credentials in summaries', () => {
  const config = { ...configuration(), sessionToken: 'private-session' };
  assert.throws(() => parseStoredProjectS3('projectb', config), unavailable);
  const summary = JSON.stringify(publicProjectStorage(config));
  for (const value of [config.accessKeyId, config.secretAccessKey, config.sessionToken]) assert.ok(!summary.includes(value));
  assert.equal(publicProjectStorage(null).backend, 'platform');
});

test('credential rotation does not change storage identity and prefix overlaps are detected', () => {
  const a = parseProjectS3Settings(settings());
  assert.ok(sameStorageNamespace(a, { ...a, secretAccessKey: 'rotated' }));
  assert.ok(!sameStorageNamespace(a, { ...a, bucket: 'different-bucket' }));
  assert.ok(overlappingStorageNamespace(a, { ...a, prefix: 'sub/' }));
  assert.ok(!overlappingStorageNamespace({ ...a, prefix: 'a/' }, { ...a, prefix: 'ab/' }));
});

test('parallel projects use independent backends for the same logical bucket and object names', async () => {
  const state = fixture();
  await state.registry.put('projecta', settings('a'), null);
  await state.registry.put('projectb', settings('b'), null);
  const fallback = new ProjectS3Driver(configuration('projectc'), memoryClient().client);
  const router = new ProjectStorageRouter((ref, op) => state.registry.withDriver(ref, fallback, op));
  await Promise.all(Array.from({ length: 12 }, async (_, i) => {
    await Promise.all([
      router.uploadFile('projecta', 'avatars', `${i}.txt`, new TextEncoder().encode(`a-${i}`), 'text/plain'),
      router.uploadFile('projectb', 'avatars', `${i}.txt`, new TextEncoder().encode(`b-${i}`), 'text/plain'),
    ]);
    assert.equal(await (await router.getDownloadResponse('projecta', 'avatars', `${i}.txt`))!.text(), `a-${i}`);
    assert.equal(await (await router.getDownloadResponse('projectb', 'avatars', `${i}.txt`))!.text(), `b-${i}`);
  }));
  assert.equal((await router.listFiles('projecta', 'avatars')).length, 12);
  assert.equal((await router.listFiles('projectb', 'avatars')).length, 12);
});

test('driver project mismatch is rejected before any S3 request', async () => {
  const state = memoryClient(); const driver = new ProjectS3Driver(configuration(), state.client);
  await assert.rejects(driver.uploadFile('projectb', 'avatars', 'same.txt', new Uint8Array(), 'text/plain'), unavailable);
  assert.equal(state.calls.length, 0);
});

test('copy, list and empty stay inside the configured project prefix across all pages', async () => {
  const state = memoryClient(); const cfg = { ...configuration(), prefix: 'tenants/a/' };
  const driver = new ProjectS3Driver(cfg, state.client);
  for (let i = 0; i < 7; i++) await driver.uploadFile('projecta', 'files', `${i}.txt`, new Uint8Array([i]), 'text/plain');
  state.values.set('tenants/b/files/keep.txt', { bytes: new Uint8Array([99]), type: 'text/plain' });
  assert.equal((await driver.listFiles('projecta', 'files')).length, 7);
  await driver.copyFile('projecta', 'files', '0.txt', 'copies', 'copy.txt');
  assert.equal((await driver.listBuckets('projecta')).length, 2);
  assert.deepEqual(await driver.deleteBucket('projecta', 'files'), { success: false, reason: 'not_empty' });
  await driver.emptyBucket('projecta', 'files');
  assert.ok(state.values.has('tenants/b/files/keep.txt')); assert.ok(state.values.has('tenants/a/copies/copy.txt'));
  assert.deepEqual(await driver.deleteBucket('projecta', 'files'), { success: true });
  assert.ok(state.calls.filter((entry) => entry.action === 'delete').every((entry) => entry.key.startsWith('tenants/a/files/')));
});

test('invalid logical names and traversal are rejected before touching S3', async () => {
  const state = memoryClient(); const driver = new ProjectS3Driver(configuration(), state.client);
  for (const key of ['../other', '/other', 'a//b', 'a\\b', 'a/./b']) await assert.rejects(driver.uploadFile('projecta', 'files', key, new Uint8Array(), 'text/plain'));
  await assert.rejects(driver.emptyBucket('projecta', '../other'));
  assert.equal(state.calls.length, 0);
});

test('backend failures are sanitized and are not missing files or empty listings', async () => {
  const state = memoryClient(); const driver = new ProjectS3Driver(configuration(), state.client); state.fail();
  await assert.rejects(driver.getDownloadResponse('projecta', 'files', 'x'), unavailable);
  await assert.rejects(driver.listFiles('projecta', 'files'), unavailable);
  await assert.rejects(driver.uploadFile('projecta', 'files', 'x', new Uint8Array(), 'text/plain'), unavailable);
});

test('genuine absence remains null and internal image URLs contain the full namespace', async () => {
  const driver = new ProjectS3Driver({ ...configuration(), prefix: 'root/' }, memoryClient().client);
  assert.equal(await driver.getDownloadResponse('projecta', 'images', 'missing.png'), null);
  assert.ok((await driver.getInternalSourceUrl('projecta', 'images', 'photo.png')).includes('/root/images/photo.png?'));
});

test('the driver snapshots configuration rather than sharing mutable project state', async () => {
  const cfg = configuration(); const state = memoryClient(); const driver = new ProjectS3Driver(cfg, state.client);
  cfg.prefix = 'wrong/'; cfg.projectRef = 'projectb';
  await driver.uploadFile('projecta', 'files', 'x', new Uint8Array(), 'text/plain');
  assert.ok(state.values.has('files/x'));
});

test('malformed pagination and out-of-prefix responses fail closed before deletion', async () => {
  const state = memoryClient();
  const loop = new ProjectS3Driver(configuration(), { ...state.client, list: async () => ({ contents: [], isTruncated: true, nextContinuationToken: 'same' }) });
  await assert.rejects(loop.listFiles('projecta', 'files'), unavailable);
  const wrong = new ProjectS3Driver(configuration(), { ...state.client, list: async () => ({ contents: [{ key: 'other/files/x' }] }) });
  await assert.rejects(wrong.emptyBucket('projecta', 'files'), unavailable);
  assert.equal(state.calls.length, 0);
});

test('an absent project binding preserves the existing legacy driver and conditional capability', async () => {
  const state = fixture(); let calls = 0;
  const legacy = new ProjectS3Driver(configuration(), memoryClient().client);
  const router = new ProjectStorageRouter((ref, operation) => state.registry.withDriver(ref, legacy, async (driver) => { calls++; assert.equal(driver, legacy); return operation(driver); }));
  assert.equal(await router.createBucket('projecta', 'files'), true);
  assert.equal(await router.uploadFileConditional('projecta', 'files', 'x', new Uint8Array(), 'text/plain', null), null);
  assert.equal(calls, 2); assert.ok(state.queries.some((query) => query.includes('pg_advisory_xact_lock_shared')));
});

test('configuration lookup failure never calls the fallback driver', async () => {
  const state = fixture(); state.failDatabase(); let called = false;
  await assert.rejects(state.registry.withDriver('projecta', {} as StorageDriver, async () => { called = true; }), unavailable);
  assert.equal(called, false);
});

test('configuration records are encrypted, project-bound, and protected by expected revision', async () => {
  const state = fixture(); const created = await state.registry.put('projecta', settings(), null);
  assert.equal(created.configured, true); assert.ok(state.stored.get('projecta')!.startsWith('sealed-'));
  await assert.rejects(state.registry.put('projecta', settings(), null), conflict);
  const rotated = await state.registry.put('projecta', { ...settings(), secretAccessKey: 'rotated' }, created.revision);
  assert.notEqual(rotated.revision, created.revision);
  await assert.rejects(state.registry.put('projecta', { ...settings(), bucket: 'new-bucket' }, rotated.revision), conflict);
});

test('binding is rejected for an occupied project or any pending upload', async () => {
  const state = fixture(); state.occupied.add('db_a');
  await assert.rejects(state.registry.put('projecta', settings(), null), conflict);
  state.occupied.clear(); state.uploads.add('projecta');
  await assert.rejects(state.registry.put('projecta', settings(), null), conflict);
  assert.equal(state.stored.size, 0);
});

test('overlapping project namespaces cannot be registered even with different credentials', async () => {
  const state = fixture(); await state.registry.put('projecta', settings(), null);
  await assert.rejects(state.registry.put('projectb', { ...settings(), prefix: 'nested/', accessKeyId: 'different-key' }, null), conflict);
  assert.equal(state.stored.size, 1);
});

test('disabled, corrupt, or no-longer-approved configurations do not fall back', async () => {
  const state = fixture(); const created = await state.registry.put('projecta', settings(), null); let called = false;
  await state.registry.put('projecta', { ...settings(), enabled: false }, created.revision);
  await assert.rejects(state.registry.withDriver('projecta', {} as StorageDriver, async () => { called = true; }), unavailable);
  assert.equal(called, false);
  assert.equal((await state.registry.describe('projecta')).available, false);
  state.stored.set('projectb', state.stored.get('projecta')!);
  await assert.rejects(state.registry.withDriver('projectb', {} as StorageDriver, async () => { called = true; }), unavailable);
  const enabled = fixture(); await enabled.registry.put('projecta', settings(), null); enabled.revokeOrigins();
  await assert.rejects(enabled.registry.withDriver('projecta', {} as StorageDriver, async () => { called = true; }), unavailable);
  assert.equal(called, false);
});

test('an unreadable binding of another project does not block a new binding', async () => {
  const state = fixture();
  // A row that cannot be decrypted/parsed belongs to a project that cannot serve
  // storage; it must not brick an unrelated project's first binding.
  state.stored.set('projectx', 'corrupt-not-decryptable');
  const created = await state.registry.put('projecta', settings(), null);
  assert.equal(created.configured, true);
});
