import { describe, expect, test } from 'bun:test';
import { migrationBindingSha256, parseMigrationBindingManifest, renderMigrationBindings } from './migration-bindings.js';

const sql = "SELECT '__SC_BINDING_APP_ID__'::uuid;";
const file = '20260908100000_binding/migration.sql';
const testId = '11111111-1111-4111-8111-111111111111';
const productionId = '22222222-2222-4222-8222-222222222222';
function input(type = 'uuid', value = testId) {
  return {
    manifest: {
      schema: 'supacloud.migration-bindings.v1',
      targets: [{ environment: 'test', projectRef: 'test-project' }, { environment: 'production', projectRef: 'prod-project' }],
      templates: [{
        file, templateSha256: migrationBindingSha256(sql),
        parameters: [{ placeholder: '__SC_BINDING_APP_ID__', variable: 'APP_ID', type, occurrences: 1 }],
      }],
    },
    target: { environment: 'test', projectRef: 'test-project' },
    migrations: [{ file, sql }],
    values: { APP_ID: value },
  };
}

describe('controlled migration bindings', () => {
  test('supports Drizzle v1 migration.sql paths without rewriting sources or snapshots', () => {
    const options = input();
    const before = JSON.stringify(options);
    const result = renderMigrationBindings(options);
    expect(result.migrations).toEqual([{ file, sql: `SELECT '${testId}'::uuid;` }]);
    expect(JSON.stringify(options)).toBe(before);
    expect(result.attestation.files[0]!.templateSha256).toBe(migrationBindingSha256(sql));
    expect(result.attestation.files[0]!.renderedSqlSha256).toBe(migrationBindingSha256(result.migrations[0]!.sql));
    expect(JSON.stringify(result.attestation)).not.toContain(testId);
    expect(JSON.stringify(result.attestation)).not.toContain('SELECT');
  });

  test('same source renders differently only for explicitly selected targets', () => {
    const dev = renderMigrationBindings(input());
    const prod = renderMigrationBindings({ ...input('uuid', productionId), target: { environment: 'production', projectRef: 'prod-project' } });
    expect(dev.attestation.files[0]!.templateSha256).toBe(prod.attestation.files[0]!.templateSha256);
    expect(dev.attestation.files[0]!.renderedSqlSha256).not.toBe(prod.attestation.files[0]!.renderedSqlSha256);
    expect(() => renderMigrationBindings({ ...input(), target: { environment: 'test', projectRef: 'prod-project' } })).toThrow('target');
  });

  test.each([
    ['uuid', "x'; DROP TABLE users;--"],
    ['uuid', '00000000-0000-0000-0000-000000000000'],
    ['resource-name', '$body$'],
    ['resource-name', 'a\\b'],
    ['resource-name', '__SC_BINDING_OTHER__'],
    ['https-url', 'http://example.com'],
    ['https-url', 'https://user:password@example.com'],
    ['https-url', "https://example.com/a'b"],
    ['https-url', 'https://example.com/$$'],
  ])('rejects unsafe %s values without echoing them', (type, value) => {
    try {
      renderMigrationBindings(input(type, value));
      throw new Error('accepted unsafe value');
    } catch (error) {
      expect(String(error)).toContain('migration binding');
      expect(String(error)).not.toContain(value);
    }
  });

  test.each([['resource-name', 'reports/archive'], ['https-url', 'https://static.example.com/fonts/font.woff2']])('accepts public %s bindings', (type, value) => {
    expect(renderMigrationBindings(input(type, value)).migrations[0]!.sql).toContain(value);
  });

  test('does not use ambient environment values or inherited object properties', () => {
    expect(() => renderMigrationBindings({ ...input(), values: {} })).toThrow('Missing');
    expect(() => renderMigrationBindings({ ...input(), values: Object.create({ APP_ID: testId }) })).toThrow('Missing');
  });

  test('pins source bytes, placeholder count and literal placement', () => {
    expect(() => renderMigrationBindings({ ...input(), migrations: [{ file, sql: `${sql}\n` }] })).toThrow('checksum');
    const options = input();
    options.manifest.templates[0]!.parameters[0]!.occurrences = 2;
    expect(() => renderMigrationBindings(options)).toThrow('occurrence');
    const unsafe = input();
    unsafe.migrations[0]!.sql = 'SELECT __SC_BINDING_APP_ID__;';
    unsafe.manifest.templates[0]!.templateSha256 = migrationBindingSha256(unsafe.migrations[0]!.sql);
    expect(() => renderMigrationBindings(unsafe)).toThrow('complete SQL string literal');
  });

  test('plain migrations are unchanged and undeclared reserved placeholders fail', () => {
    const options = input();
    options.migrations.push({ file: '20260908000000_schema.sql', sql: 'CREATE TABLE sample(id int);' });
    expect(renderMigrationBindings(options).migrations[1]).toEqual(options.migrations[1]);
    options.migrations[1]!.sql = "SELECT '__SC_BINDING_UNKNOWN__';";
    expect(() => renderMigrationBindings(options)).toThrow('Undeclared');
  });

  test('rejects stale, duplicate, traversal, unknown-type and wildcard manifests', () => {
    const missing = input();
    missing.migrations = [];
    expect(() => renderMigrationBindings(missing)).toThrow('missing source');
    const duplicate = input();
    duplicate.manifest.templates.push(duplicate.manifest.templates[0]!);
    expect(() => renderMigrationBindings(duplicate)).toThrow('duplicate');
    const traversal = input();
    traversal.manifest.templates[0]!.file = '../escape.sql';
    expect(() => parseMigrationBindingManifest(traversal.manifest)).toThrow();
    expect(() => renderMigrationBindings(input('raw-sql'))).toThrow();
    const wildcard = input();
    wildcard.manifest.targets[0]!.projectRef = '*';
    expect(() => renderMigrationBindings(wildcard)).toThrow();
    expect(() => parseMigrationBindingManifest({ ...input().manifest, allowMissing: true })).toThrow('Unexpected');
  });

  test('supports restricted literals in dollar-quoted SQL function bodies and legacy tokens', () => {
    const options = input();
    options.migrations[0]!.sql = "DO $body$ BEGIN PERFORM '__FA_CLIENT_ID__'::uuid; END $body$;";
    options.manifest.templates[0]!.templateSha256 = migrationBindingSha256(options.migrations[0]!.sql);
    options.manifest.templates[0]!.parameters[0]!.placeholder = '__FA_CLIENT_ID__';
    expect(renderMigrationBindings(options).migrations[0]!.sql).toContain(`'${testId}'`);
  });
});
