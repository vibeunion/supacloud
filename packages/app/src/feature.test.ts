import { expect, test } from "bun:test";
import { defineFeatureSpec, type FeatureEvent, type FeatureState } from "./index";

test("feature states and events retain their literal types", () => {
  const spec = defineFeatureSpec({
    name: "review",
    states: ["draft", "approved"],
    transitions: { approve: { from: "draft", to: "approved" } },
  });
  const state: FeatureState<typeof spec> = "approved";
  const event: FeatureEvent<typeof spec> = "approve";
  expect(spec.transitions[event].to).toBe(state);
  // @ts-expect-error Undeclared states must fail before application compilation.
  const invalidState: FeatureState<typeof spec> = "missing";
  // @ts-expect-error Undeclared events are not part of the contract.
  const invalidEvent: FeatureEvent<typeof spec> = "delete";
  void [invalidState, invalidEvent];
  defineFeatureSpec({
    name: "invalid",
    states: ["draft", "approved"],
    // @ts-expect-error Transition endpoints must belong to the declared states.
    transitions: {
      approve: { from: "draft", to: "missing" },
    },
  });
});
