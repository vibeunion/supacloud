import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const Key = Type.String({ minLength: 1, maxLength: 100, pattern: '^[a-z][a-z0-9_.-]*$' });
const Scalar = Type.Union([Type.Null(), Type.Boolean(), Type.Number({ minimum: -1e15, maximum: 1e15 }),
  Type.String({ maxLength: 256 })]);
export const ApprovalGraphFactsSchema = Type.Record(Key,Scalar,{ maxProperties: 64 });
export const ApprovalGraphDefinitionSchema = Type.Object({
  schemaVersion: Type.Literal(5),
  subjectResolver: Key,
  nodes: Type.Array(Type.Object({
    key: Key,
    after: Type.Array(Key,{ maxItems: 32,uniqueItems: true }),
    mode: Type.Union([Type.Literal('all'),Type.Literal('any'),Type.Literal('claim'),Type.Literal('quorum')]),
    assignment: Type.Object({ resolver: Key,scope: Type.String({ minLength: 1,maxLength: 256 }) },{ additionalProperties: false }),
    timeoutSeconds: Type.Integer({ minimum: 1,maximum: 2592000 }),
    quorum: Type.Optional(Type.Integer({ minimum: 1,maximum: 50 })),
    quorumPercent: Type.Optional(Type.Integer({ minimum: 1,maximum: 100 })),
    choice: Type.Optional(Key),
    when: Type.Optional(Type.Object({ field: Key,equals: Scalar },{ additionalProperties: false })),
    default: Type.Optional(Type.Literal(true)),
  },{ additionalProperties: false }),{ minItems: 1,maxItems: 32 }),
},{ additionalProperties: false });
export type ApprovalGraphDefinition = Static<typeof ApprovalGraphDefinitionSchema>;
export type ApprovalGraphFacts = Static<typeof ApprovalGraphFactsSchema>;

export function decodeApprovalGraph(value: unknown): ApprovalGraphDefinition {
  if (!Value.Check(ApprovalGraphDefinitionSchema,value)) throw new Error('APPROVAL_GRAPH_INVALID');
  const nodes = new Map(value.nodes.map(node => [node.key,node]));
  if (nodes.size !== value.nodes.length) throw new Error('APPROVAL_DUPLICATE_NODE');
  for (const node of value.nodes) {
    if (node.after.some(key => key === node.key || !nodes.has(key))) throw new Error('APPROVAL_GRAPH_DEPENDENCY_INVALID');
    const thresholds = Number(node.quorum !== undefined) + Number(node.quorumPercent !== undefined);
    if (thresholds !== (node.mode === 'quorum' ? 1 : 0)) throw new Error('APPROVAL_QUORUM_INVALID');
    if (node.choice === undefined ? node.when !== undefined || node.default !== undefined
      : Number(node.when !== undefined) + Number(node.default !== undefined) !== 1) throw new Error('APPROVAL_CHOICE_INVALID');
  }
  for (const choice of new Set(value.nodes.flatMap(node => node.choice === undefined ? [] : [node.choice]))) {
    const group = value.nodes.filter(node => node.choice === choice);
    const first = group[0];
    if (first === undefined || group.length < 2 || group.filter(node => node.default).length !== 1
      || group.some(node => [...node.after].sort().join('\0') !== [...first.after].sort().join('\0'))) {
      throw new Error('APPROVAL_CHOICE_INVALID');
    }
  }
  const visited = new Set<string>();
  while (visited.size < nodes.size) {
    const ready = value.nodes.filter(node => !visited.has(node.key) && node.after.every(key => visited.has(key)));
    if (ready.length === 0) throw new Error('APPROVAL_GRAPH_CYCLE');
    for (const node of ready) visited.add(node.key);
  }
  return Value.Clone(value);
}

/** Bounded equality-only routing. No scripts, SQL, paths or expression evaluation. */
export function planApprovalGraph(definition: unknown,facts: unknown): readonly { key: string; selected: boolean; level: number }[] {
  const decoded = decodeApprovalGraph(definition);
  if (!Value.Check(ApprovalGraphFactsSchema,facts)) throw new Error('APPROVAL_GRAPH_FACTS_INVALID');
  const selected = new Map<string,boolean>();
  for (const node of decoded.nodes) {
    if (node.when !== undefined && !Object.hasOwn(facts,node.when.field)) throw new Error(`APPROVAL_GRAPH_FACT_MISSING:${node.when.field}`);
    selected.set(node.key,node.choice === undefined || (node.when !== undefined && facts[node.when.field] === node.when.equals));
  }
  for (const choice of new Set(decoded.nodes.flatMap(node => node.choice === undefined ? [] : [node.choice]))) {
    const group = decoded.nodes.filter(node => node.choice === choice);
    const matches = group.filter(node => selected.get(node.key));
    if (matches.length > 1) throw new Error(`APPROVAL_AMBIGUOUS_ROUTE:${choice}`);
    for (const node of group) if (node.default) selected.set(node.key,matches.length === 0);
  }
  const result = new Map<string,{ key: string; selected: boolean; level: number }>();
  while (result.size < decoded.nodes.length) {
    for (const node of decoded.nodes) {
      if (result.has(node.key) || node.after.some(key => !result.has(key))) continue;
      const dependencies = node.after.map(key => result.get(key));
      const active = selected.get(node.key) === true && (dependencies.length === 0 || dependencies.some(item => item?.selected));
      result.set(node.key,{ key: node.key,selected: active,level: dependencies.reduce((level,item) => Math.max(level,(item?.level ?? -1)+1),0) });
    }
  }
  return decoded.nodes.map(node => {
    const planned = result.get(node.key);
    if (planned === undefined) throw new Error('APPROVAL_GRAPH_INVALID');
    return planned;
  });
}
