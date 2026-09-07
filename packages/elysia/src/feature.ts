import { ApplicationError } from "./index";

/** Structural contract: the runtime does not import the compiler or discover metadata. */
export interface FeatureTransitionSpec {
  name: string;
  states: readonly string[];
  transitions: Readonly<Record<string, { from: string; to: string }>>;
}

/**
 * Check a declared transition against an authoritative state read by the caller.
 * This is a matrix assertion, not persistence, authorization, or an FSM engine.
 * Call inside the application's transaction and persist with a version check.
 */
export function assertFeatureTransition<Spec extends FeatureTransitionSpec>(
  spec: Spec,
  state: string,
  event: string,
): Spec["states"][number] {
  const transition = Object.hasOwn(spec.transitions, event) ? spec.transitions[event] : undefined;
  if (!transition || !spec.states.includes(state) || transition.from !== state) {
    throw new ApplicationError("Feature transition is not allowed", {
      status: 409,
      code: "FEATURE_TRANSITION_CONFLICT",
    });
  }
  if (!spec.states.includes(transition.to)) {
    throw new ApplicationError("Feature transition references an undeclared state", {
      code: "FEATURE_SPEC_INVALID",
    });
  }
  return transition.to;
}
