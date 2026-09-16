import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const Text = Type.String({ minLength: 1, maxLength: 256, pattern: '^\\S(?:.*\\S)?$' });
const Version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const SnapshotSchema = Type.Object({
  definitionKey: Text, definitionVersion: Text, tenantId: Text, entityId: Text,
  state: Text, rowVersion: Version,
}, { additionalProperties: false });
export const InputSchema = Type.Object({
  snapshot: SnapshotSchema, expectedRowVersion: Version, requestId: Text, actorId: Text, event: Text,
  context: Type.Unknown(),
}, { additionalProperties: false });
const DefinitionSchema = Type.Object({
  key: Text, version: Text, initial: Text,
  states: Type.Array(Text, { minItems: 1, maxItems: 128, uniqueItems: true }),
  terminal: Type.Array(Text, { minItems: 1, maxItems: 128, uniqueItems: true }),
  transitions: Type.Array(Type.Object({
    from: Text, event: Text, to: Text, guard: Text,
  }, { additionalProperties: false }), { maxItems: 1024 }),
}, { additionalProperties: false });
export const ObservationSchema = Type.Union([
  Type.Object({ kind: Type.Literal('unknown') }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Union([Type.Literal('committed'), Type.Literal('rejected')]),
    requestId: Text, actorId: Text, event: Text, snapshot: SnapshotSchema, idempotent: Type.Boolean(),
  }, { additionalProperties: false }),
]);
export const EvaluationSchema = Type.Intersect([
  Type.Object({ before: SnapshotSchema, requestId: Text, actorId: Text, event: Text }),
  Type.Union([
    Type.Object({ kind: Type.Literal('proposal'), nextState: Text }),
    Type.Object({
      kind: Type.Literal('blocked'),
      code: Type.Union(([
        'invalid_snapshot', 'definition_mismatch', 'stale_version', 'invalid_transition',
        'guard_denied', 'guard_failed', 'ambiguous_transition',
      ] as const).map(code => Type.Literal(code))),
      reasons: Type.Array(Type.String({ maxLength: 256 }), { maxItems: 1024 }),
    }),
  ]),
]);

export class ApprovalContractError extends Error {
  readonly code = 'APPROVAL_CONTRACT_INVALID';
  constructor(readonly boundary: 'definition' | 'input' | 'facts' | 'observation') {
    super(`Invalid approval ${boundary}`);
    this.name = 'ApprovalContractError';
  }
}

/** Accept JSON-like values only; no getters, class instances, cycles or shared mutable facts. */
export function immutableData<T>(value: T, boundary: ApprovalContractError['boundary']): T {
  let count = 0;
  let textSize = 0;
  const stack = new WeakSet<object>();
  function copy(item: unknown, depth: number): unknown {
    if (++count > 20_000 || depth > 32) throw new ApprovalContractError(boundary);
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string' && item.length <= 65_536) {
      textSize += item.length;
      if (textSize > 262_144) throw new ApprovalContractError(boundary);
      return item;
    }
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || stack.has(item)) throw new ApprovalContractError(boundary);
    const prototype: unknown = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) {
      throw new ApprovalContractError(boundary);
    }
    stack.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) {
      throw new ApprovalContractError(boundary);
    }
    const entries: [string, unknown][] = [];
    for (const [key, descriptor] of Object.entries(descriptors)) {
      textSize += key.length;
      if (textSize > 262_144) throw new ApprovalContractError(boundary);
      if (Array.isArray(item) && key === 'length') continue;
      if (!('value' in descriptor) || !descriptor.enumerable
        || ['__proto__', 'constructor', 'prototype'].includes(key)) {
        throw new ApprovalContractError(boundary);
      }
      entries.push([key, copy(descriptor.value, depth + 1)]);
    }
    if (Array.isArray(item)
      && (entries.length !== item.length || entries.some(([key], index) => key !== String(index)))) {
      throw new ApprovalContractError(boundary);
    }
    stack.delete(item);
    return Object.freeze(Array.isArray(item) ? entries.map(([, entry]) => entry) : Object.fromEntries(entries));
  }
  // The clone retains the JSON data shape; no coercion or new domain fields are introduced.
  return copy(value, 0) as T;
}

export function decodeApprovalDefinition(value: unknown): Static<typeof DefinitionSchema> {
  const copied = immutableData(value, 'definition');
  if (!Value.Check(DefinitionSchema, copied)) throw new ApprovalContractError('definition');
  return copied;
}

export function decodeApprovalInput<Context>(
  value: unknown,
  decodeContext: (value: unknown) => Context,
): Omit<Static<typeof InputSchema>, 'context'> & { readonly context: Context } {
  const copied = immutableData(value, 'input');
  if (!Value.Check(InputSchema, copied)) throw new ApprovalContractError('input');
  return Object.freeze({ ...copied, context: immutableData(decodeContext(copied.context), 'facts') });
}

export function decodeApprovalObservation(value: unknown): Static<typeof ObservationSchema> {
  const copied = immutableData(value, 'observation');
  if (!Value.Check(ObservationSchema, copied)) throw new ApprovalContractError('observation');
  return copied;
}
