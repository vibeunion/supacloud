import { createHash } from 'node:crypto';

export type MigrationBindingType = 'uuid' | 'https-url' | 'resource-name';

export interface MigrationBindingTarget {
  environment: string;
  projectRef: string;
}

export interface MigrationBindingParameter {
  placeholder: string;
  variable: string;
  type: MigrationBindingType;
  occurrences: number;
}

export interface MigrationBindingTemplate {
  file: string;
  templateSha256: string;
  parameters: MigrationBindingParameter[];
}

export interface MigrationBindingManifest {
  schema: 'supacloud.migration-bindings.v1';
  targets: MigrationBindingTarget[];
  templates: MigrationBindingTemplate[];
}

export interface MigrationBindingSource {
  file: string;
  sql: string;
}

const TOKEN = /__[A-Z][A-Z0-9_]*__/g;
const RESERVED_TOKEN = /__SC_BINDING_[A-Z0-9_]+__/;
const HASH = /^[a-f0-9]{64}$/;

export function migrationBindingSha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid migration binding object');
  }
  return value as Record<string, unknown>;
}

function keys(row: Record<string, unknown>, expected: string[]): void {
  if (Object.keys(row).sort().join(',') !== expected.sort().join(',')) {
    throw new Error('Unexpected migration binding fields');
  }
}

function validTarget(value: unknown): MigrationBindingTarget {
  const target = record(value);
  keys(target, ['environment', 'projectRef']);
  if (typeof target.environment !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/.test(target.environment)
    || typeof target.projectRef !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(target.projectRef)) {
    throw new Error('Invalid migration binding target');
  }
  return target as unknown as MigrationBindingTarget;
}

function validFile(file: unknown): file is string {
  return typeof file === 'string' && /^[a-zA-Z0-9_./-]+\.sql$/.test(file)
    && !file.startsWith('/') && file.split('/').every((part) => part && part !== '.' && part !== '..');
}

export function parseMigrationBindingManifest(value: unknown): MigrationBindingManifest {
  const manifest = record(value);
  keys(manifest, ['schema', 'targets', 'templates']);
  if (manifest.schema !== 'supacloud.migration-bindings.v1'
    || !Array.isArray(manifest.targets) || !manifest.targets.length || !Array.isArray(manifest.templates)) {
    throw new Error('Invalid migration binding manifest');
  }
  const targets = manifest.targets.map(validTarget);
  if (new Set(targets.map((target) => target.environment)).size !== targets.length) {
    throw new Error('Duplicate migration binding environment');
  }
  const files = new Set<string>();
  const templates = manifest.templates.map((value) => {
    const template = record(value);
    keys(template, ['file', 'templateSha256', 'parameters']);
    if (!validFile(template.file) || files.has(template.file)
      || typeof template.templateSha256 !== 'string' || !HASH.test(template.templateSha256)
      || !Array.isArray(template.parameters) || !template.parameters.length) {
      throw new Error('Invalid or duplicate migration binding template');
    }
    files.add(template.file);
    const placeholders = new Set<string>();
    const parameters = template.parameters.map((value) => {
      const parameter = record(value);
      keys(parameter, ['placeholder', 'variable', 'type', 'occurrences']);
      if (typeof parameter.placeholder !== 'string' || !/^__[A-Z][A-Z0-9_]*__$/.test(parameter.placeholder)
        || placeholders.has(parameter.placeholder) || typeof parameter.variable !== 'string'
        || !/^[A-Z][A-Z0-9_]*$/.test(parameter.variable)
        || !['uuid', 'https-url', 'resource-name'].includes(String(parameter.type))
        || !Number.isSafeInteger(parameter.occurrences) || Number(parameter.occurrences) < 1) {
        throw new Error('Invalid or duplicate migration binding parameter');
      }
      placeholders.add(parameter.placeholder);
      return parameter as unknown as MigrationBindingParameter;
    });
    return { file: template.file, templateSha256: template.templateSha256, parameters };
  });
  return { schema: 'supacloud.migration-bindings.v1', targets, templates };
}

function bindingValue(parameter: MigrationBindingParameter, values: Readonly<Record<string, string | undefined>>): string {
  const value = Object.hasOwn(values, parameter.variable) ? values[parameter.variable] : undefined;
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw new Error(`Missing or invalid migration binding variable: ${parameter.variable}`);
  }
  let valid = false;
  if (parameter.type === 'uuid') {
    valid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  } else if (parameter.type === 'resource-name') {
    valid = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(value);
  } else if (/^https:\/\/[A-Za-z0-9._~:/?#[\]@!&()*+,;=%-]+$/.test(value)) {
    try {
      const url = new URL(value);
      valid = url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
    } catch { /* Invalid URL; never echo the value. */ }
  }
  // Only public, restricted-alphabet values are supported. No quotes, dollar
  // delimiters, backslashes, raw SQL, secrets, or arbitrary text interpolation.
  if (!valid || value.includes('__')) throw new Error(`Invalid ${parameter.type} migration binding: ${parameter.variable}`);
  return value;
}

/**
 * Pure rendering of explicitly declared SQL literals. The caller supplies an
 * already-selected environment; this module never reads files or process.env.
 */
export function renderMigrationBindings(options: {
  manifest: unknown;
  target: MigrationBindingTarget;
  migrations: readonly MigrationBindingSource[];
  values: Readonly<Record<string, string | undefined>>;
}) {
  const manifest = parseMigrationBindingManifest(options.manifest);
  const target = validTarget(options.target);
  if (!manifest.targets.some((candidate) => candidate.environment === target.environment && candidate.projectRef === target.projectRef)) {
    throw new Error('Migration binding target is not registered in the manifest');
  }
  const sources = new Map<string, MigrationBindingSource>();
  for (const migration of options.migrations) {
    if (!validFile(migration.file) || sources.has(migration.file) || typeof migration.sql !== 'string' || !migration.sql.trim()) {
      throw new Error('Invalid, empty, or duplicate migration binding source');
    }
    sources.set(migration.file, migration);
  }
  if (manifest.templates.some((template) => !sources.has(template.file))) {
    throw new Error('Migration binding manifest references a missing source');
  }
  const templates = new Map(manifest.templates.map((template) => [template.file, template]));
  const declaredTokens = new Set(manifest.templates.flatMap((template) => template.parameters.map((parameter) => parameter.placeholder)));
  const files: Array<{
    file: string; templateSha256: string; renderedSqlSha256: string;
    parameters: Array<{ variable: string; type: MigrationBindingType }>;
  }> = [];
  const migrations = options.migrations.map((migration) => {
    const template = templates.get(migration.file);
    const templateSha256 = migrationBindingSha256(migration.sql);
    if (template && templateSha256 !== template.templateSha256) {
      throw new Error(`Migration binding template checksum mismatch: ${migration.file}`);
    }
    const parameters = new Map(template?.parameters.map((parameter) => [parameter.placeholder, parameter]));
    const counts = new Map<string, number>();
    // One pass: replacement values cannot introduce a second interpolation.
    const sql = migration.sql.replace(TOKEN, (token, offset: number) => {
      const parameter = parameters.get(token);
      if (!parameter) {
        if (RESERVED_TOKEN.test(token) || declaredTokens.has(token)) {
          throw new Error(`Undeclared migration binding placeholder: ${migration.file}`);
        }
        return token;
      }
      if (migration.sql[offset - 1] !== "'" || migration.sql[offset + token.length] !== "'") {
        throw new Error(`Migration bindings must occupy a complete SQL string literal: ${migration.file}`);
      }
      counts.set(token, (counts.get(token) || 0) + 1);
      return bindingValue(parameter, options.values);
    });
    for (const parameter of parameters.values()) {
      if (counts.get(parameter.placeholder) !== parameter.occurrences) {
        throw new Error(`Migration binding occurrence mismatch: ${migration.file}`);
      }
    }
    files.push({
      file: migration.file, templateSha256, renderedSqlSha256: migrationBindingSha256(sql),
      parameters: [...parameters.values()].map(({ variable, type }) => ({ variable, type })),
    });
    return { file: migration.file, sql };
  });
  return {
    migrations,
    attestation: {
      schema: 'supacloud.migration-binding-attestation.v1' as const,
      ...target,
      manifestSha256: migrationBindingSha256(JSON.stringify(manifest)),
      files: files.sort((left, right) => left.file.localeCompare(right.file)),
    },
  };
}
