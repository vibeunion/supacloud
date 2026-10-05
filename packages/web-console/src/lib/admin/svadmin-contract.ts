import type { TSchema } from 'typebox';
import { defineResource, type ResourceContract } from '@svadmin/core/resource-contract';

/**
 * @svadmin/core@0.58 pins `@sinclair/typebox@0.34`, whose schema nodes carry
 * their type identity on the global `Symbol.for('TypeBox.Kind')` symbol plus
 * `~`-prefixed symbols. TypeBox 1.x stores the same information as the
 * `"~kind"` string, so a 1.x schema fails SVAdmin's `Kind`-based runtime guard
 * (`INVALID_RESOURCE_CONTRACT`).
 *
 * Tagging the 1.x nodes with the legacy global symbol lets SVAdmin normalize
 * them through its own 0.34 `CloneType`/`TypeGuard` pipeline, while all
 * first-party code — including every other schema in this package — is built
 * with `typebox@1.x`. Remove this adapter once an SVAdmin release targets
 * TypeBox 1.x.
 */
const LEGACY_KIND = Symbol.for('TypeBox.Kind');

function tagLegacyKind(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) tagLegacyKind(item);
    return;
  }
  if (typeof node !== 'object' || node === null) return;

  const schema = node as Record<string, unknown>;
  if (typeof schema['~kind'] === 'string') {
    Object.defineProperty(schema, LEGACY_KIND, {
      value: schema['~kind'],
      enumerable: false,
      configurable: true,
    });
  }
  if (typeof schema.properties === 'object' && schema.properties !== null) {
    for (const property of Object.values(schema.properties)) tagLegacyKind(property);
  }
  for (const keyword of ['items', 'anyOf', 'allOf', 'oneOf', 'not']) {
    const value = schema[keyword];
    if (Array.isArray(value)) for (const item of value) tagLegacyKind(item);
    else if (value) tagLegacyKind(value);
  }
}

/**
 * `defineResource` whose compile-time `SafeSchema` inference is bypassed (the
 * property map is built from live metadata) and whose record schema is bridged
 * to the legacy type identity SVAdmin still requires at runtime.
 */
export function defineSvadminResource(
  name: string,
  schemas: { record: TSchema },
): ResourceContract {
  tagLegacyKind(schemas.record);
  return (defineResource as unknown as (
    name: string,
    schemas: { record: TSchema },
  ) => ResourceContract)(name, schemas);
}