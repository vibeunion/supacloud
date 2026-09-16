import { setup, transition } from 'xstate';
import { Value } from '@sinclair/typebox/value';
import {
  ApprovalContractError, decodeApprovalDefinition, immutableData,
  EvaluationSchema, ObservationSchema, InputSchema,
} from './validation.js';
export { ApprovalContractError, decodeApprovalDefinition, decodeApprovalInput, decodeApprovalObservation } from './validation.js';
export { runApprovalShadow } from './shadow.js';
export type { ApprovalShadowOptions, ApprovalShadowMetric } from './shadow.js';

export interface ApprovalTransition<State extends string, Event extends string> {
  readonly from: State;
  readonly event: Event;
  readonly to: State;
  readonly guard: string;
}

export interface ApprovalDefinition<State extends string, Event extends string> {
  readonly key: string;
  readonly version: string;
  readonly initial: State;
  readonly states: readonly State[];
  readonly terminal: readonly State[];
  readonly transitions: readonly ApprovalTransition<State, Event>[];
}

export type GuardDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export type ApprovalGuard<Context> = (
  context: Readonly<Context>,
  scope: { readonly snapshot: ApprovalSnapshot<string>; readonly event: string; readonly actorId: string },
) => GuardDecision;

export interface ApprovalSnapshot<State extends string> {
  readonly definitionKey: string;
  readonly definitionVersion: string;
  readonly tenantId: string;
  readonly entityId: string;
  readonly state: State;
  readonly rowVersion: number;
}

export interface ApprovalInput<State extends string, Event extends string, Context> {
  readonly snapshot: ApprovalSnapshot<State>;
  readonly expectedRowVersion: number;
  readonly requestId: string;
  readonly actorId: string;
  readonly event: Event;
  readonly context: Readonly<Context>;
}

export type ApprovalBlockCode =
  | 'invalid_snapshot'
  | 'definition_mismatch'
  | 'stale_version'
  | 'invalid_transition'
  | 'guard_denied'
  | 'guard_failed'
  | 'ambiguous_transition';

export type ApprovalEvaluation<State extends string> = {
  readonly before: ApprovalSnapshot<State>;
  readonly requestId: string;
  readonly actorId: string;
  readonly event: string;
} & (
  | { readonly kind: 'proposal'; readonly nextState: State }
  | { readonly kind: 'blocked'; readonly code: ApprovalBlockCode; readonly reasons: readonly string[] }
);

const validName = (value: string): boolean =>
  /^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(value)
  && !['constructor', 'prototype', '__proto__'].includes(value);
const nonempty = (value: string): boolean => typeof value === 'string' && value.trim().length > 0;
const validVersion = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

function validateDefinition<State extends string, Event extends string>(
  definition: ApprovalDefinition<State, Event>,
  guardNames: ReadonlySet<string>,
): void {
  const states = new Set(definition.states);
  if (!nonempty(definition.key) || !nonempty(definition.version)
    || states.size === 0 || states.size !== definition.states.length
    || definition.states.some(state => !validName(state))
    || !states.has(definition.initial) || definition.terminal.length === 0
    || new Set(definition.terminal).size !== definition.terminal.length
    || definition.terminal.some(state => !states.has(state))) {
    throw new Error('Invalid approval definition identity or states');
  }
  const edges = new Set<string>();
  for (const edge of definition.transitions) {
    const identity = JSON.stringify([edge.from, edge.event, edge.to, edge.guard]);
    if (!states.has(edge.from) || !states.has(edge.to)
      || definition.terminal.includes(edge.from)
      || !nonempty(edge.event) || edge.event === '*' || edge.event.endsWith('.*')
      || !guardNames.has(edge.guard)
      || edges.has(identity)) {
      throw new Error('Invalid approval transition or unregistered guard');
    }
    edges.add(identity);
  }
  const reachable = new Set<State>([definition.initial]);
  const canFinish = new Set<State>(definition.terminal);
  for (let i = 0; i < states.size; i++) {
    for (const edge of definition.transitions) {
      if (reachable.has(edge.from)) reachable.add(edge.to);
      if (canFinish.has(edge.to)) canFinish.add(edge.from);
    }
  }
  if (definition.states.some(state => !reachable.has(state) || !canFinish.has(state))) {
    throw new Error('Approval states must be reachable and have a path to a terminal state');
  }
}

/** Pure advisory model. The application's transaction remains the authorization boundary. */
export function createApprovalModel<State extends string, Event extends string, Context>(
  source: ApprovalDefinition<State, Event>,
  sourceGuards: Readonly<Record<string, ApprovalGuard<Context>>>,
) {
  decodeApprovalDefinition(source);
  // Copy caller-owned configuration so later editor mutations cannot alter a pinned model.
  const definition = Object.freeze({
    ...source,
    states: Object.freeze([...source.states]),
    terminal: Object.freeze([...source.terminal]),
    transitions: Object.freeze(source.transitions.map(edge => Object.freeze({ ...edge }))),
  });
  const guards = Object.freeze({ ...sourceGuards });
  validateDefinition(definition, new Set(Object.keys(guards)));
  if (Object.values(guards).some(guard => typeof guard !== 'function')) {
    throw new Error('Approval guards must be synchronous functions');
  }

  type MachineContext = { selected: number };
  type MachineEdge = { target: string; guard: (args: { context: MachineContext }) => boolean };
  const states: Record<string, { on: Record<string, MachineEdge[]> }> = Object.fromEntries(
    definition.states.map(state => [state, { on: Object.create(null) as Record<string, MachineEdge[]> }]),
  );
  definition.transitions.forEach((edge, index) => {
    const node = states[edge.from];
    if (!node) throw new Error('Missing approval state');
    (node.on[edge.event] ??= []).push({
      target: `#approval.${edge.to}`,
      guard: ({ context }) => context.selected === index,
    });
  });
  const machine = setup({
    types: {
      context: {} as MachineContext,
      events: {} as { type: string },
    },
  }).createMachine({
    id: 'approval',
    initial: definition.initial,
    context: { selected: -1 },
    states,
  });

  function evaluate(input: ApprovalInput<State, Event, Context>): ApprovalEvaluation<State> {
    if (!input || typeof input !== 'object' || !input.snapshot || typeof input.snapshot !== 'object') {
      throw new ApprovalContractError('input');
    }
    const before = Object.freeze({ ...input.snapshot });
    const base = { before, requestId: input.requestId, actorId: input.actorId, event: input.event };
    const block = (code: ApprovalBlockCode, reasons: readonly string[] = []): ApprovalEvaluation<State> =>
      Object.freeze({ ...base, kind: 'blocked', code, reasons: Object.freeze([...reasons]) });
    if (!nonempty(before.tenantId) || !nonempty(before.entityId) || !nonempty(input.requestId)
      || !validVersion(before.rowVersion) || !validVersion(input.expectedRowVersion)
      || !definition.states.includes(before.state)) return block('invalid_snapshot');
    if (!Value.Check(InputSchema, input)) throw new ApprovalContractError('input');
    if (before.definitionKey !== definition.key || before.definitionVersion !== definition.version) {
      return block('definition_mismatch');
    }
    if (before.rowVersion !== input.expectedRowVersion) return block('stale_version');
    const candidates = definition.transitions
      .map((edge, index) => ({ edge, index }))
      .filter(({ edge }) => edge.from === before.state && edge.event === input.event);
    if (candidates.length === 0) return block('invalid_transition');
    const allowed: typeof candidates = [];
    const reasons: string[] = [];
    let context: Readonly<Context>;
    try {
      context = immutableData(input.context, 'facts');
    } catch {
      return block('guard_failed');
    }
    for (const candidate of candidates) {
      const guard = guards[candidate.edge.guard];
      if (!guard) return block('guard_failed');
      try {
        const decision = guard(context, Object.freeze({ snapshot: before, event: input.event, actorId: input.actorId }));
        if (decision && typeof decision === 'object' && 'then' in decision) {
          // Absorb a rejected promise from an incorrectly implemented async guard.
          void Promise.resolve(decision).catch(() => undefined);
          return block('guard_failed');
        }
        if (decision?.allowed === true) allowed.push(candidate);
        else if (decision?.allowed === false && nonempty(decision.reason) && decision.reason.length <= 256) reasons.push(decision.reason);
        else return block('guard_failed');
      } catch {
        // Guard errors may contain sensitive domain data; do not expose them in projections.
        return block('guard_failed');
      }
    }
    if (allowed.length === 0) return block('guard_denied', reasons);
    if (allowed.length !== 1) return block('ambiguous_transition');
    const selected = allowed[0];
    if (!selected) return block('guard_failed');
    const current = machine.resolveState({ value: before.state, context: { selected: selected.index } });
    const [next] = transition(machine, current, { type: input.event });
    if (next.value !== selected.edge.to) return block('guard_failed');
    return Object.freeze({ ...base, kind: 'proposal', nextState: selected.edge.to });
  }

  return Object.freeze({ definition, evaluate });
}

export type ApprovalObservation<State extends string> =
  | { readonly kind: 'unknown' }
  | {
    readonly kind: 'committed' | 'rejected';
    readonly requestId: string;
    readonly actorId: string;
    readonly event: string;
    readonly snapshot: ApprovalSnapshot<State>;
    readonly idempotent: boolean;
  };

export interface ApprovalComparison {
  readonly kind: 'match' | 'mismatch' | 'inconclusive';
  readonly reason: string;
}

/** Compare only a normalized, authoritative command outcome, never a transport timeout. */
export function compareApprovalOutcome<State extends string>(
  prediction: ApprovalEvaluation<State>,
  observation: ApprovalObservation<State>,
): ApprovalComparison {
  try {
    prediction = immutableData(prediction, 'observation');
    observation = immutableData(observation, 'observation');
  } catch {
    return { kind: 'inconclusive', reason: 'invalid_contract' };
  }
  // Validate without intersecting the readonly domain union with TypeBox's mutable array types.
  if (!Value.Check(EvaluationSchema, prediction as unknown) || !Value.Check(ObservationSchema, observation as unknown)) {
    return { kind: 'inconclusive', reason: 'invalid_contract' };
  }
  if (prediction.kind === 'blocked'
    && ['invalid_snapshot', 'definition_mismatch', 'guard_failed', 'ambiguous_transition'].includes(prediction.code)) {
    return { kind: 'inconclusive', reason: 'model_unavailable' };
  }
  if (observation.kind === 'unknown') return { kind: 'inconclusive', reason: 'outcome_unknown' };
  const before = prediction.before;
  const after = observation.snapshot;
  if (prediction.requestId !== observation.requestId || prediction.actorId !== observation.actorId
    || prediction.event !== observation.event
    || before.tenantId !== after.tenantId || before.entityId !== after.entityId
    || before.definitionKey !== after.definitionKey || before.definitionVersion !== after.definitionVersion) {
    return { kind: 'mismatch', reason: 'identity_mismatch' };
  }
  if (observation.idempotent) {
    return { kind: 'inconclusive', reason: 'replay_requires_original_prediction' };
  }
  if (!validVersion(after.rowVersion)) return { kind: 'mismatch', reason: 'invalid_version' };
  if (observation.kind === 'rejected') {
    if (after.state !== before.state || after.rowVersion !== before.rowVersion) {
      return { kind: 'mismatch', reason: 'rejected_state_changed' };
    }
    return prediction.kind === 'blocked'
      ? { kind: 'match', reason: 'both_rejected' }
      : { kind: 'mismatch', reason: 'unexpected_rejection' };
  }
  if (prediction.kind === 'blocked') return { kind: 'mismatch', reason: 'unexpected_commit' };
  if (after.state !== prediction.nextState || after.rowVersion <= before.rowVersion) {
    return { kind: 'mismatch', reason: 'committed_state_mismatch' };
  }
  return { kind: 'match', reason: 'committed_as_predicted' };
}
