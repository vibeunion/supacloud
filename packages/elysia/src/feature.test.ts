import { expect, test } from "bun:test";
import { ApplicationError, assertFeatureTransition } from "./index";

const spec = {
  name: "review",
  states: ["draft", "approved"],
  transitions: { approve: { from: "draft", to: "approved" } },
} as const;

test("resolves the declared destination without mutating the source", () => {
  expect(assertFeatureTransition(spec, "draft", "approve")).toBe("approved");
  expect(spec.transitions.approve.from).toBe("draft");
});

test("rejects illegal states, unknown events and inherited object members", () => {
  for (const [state, event] of [
    ["approved", "approve"], ["missing", "approve"],
    ["draft", "missing"], ["draft", "toString"], ["draft", "__proto__"],
  ]) {
    try {
      assertFeatureTransition(spec, state, event);
      throw new Error("Expected conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect(error).toMatchObject({ status: 409, code: "FEATURE_TRANSITION_CONFLICT" });
    }
  }
});

test("rejects malformed runtime specs even when static compilation was bypassed", () => {
  expect(() => assertFeatureTransition({
    ...spec, transitions: { approve: { from: "draft", to: "missing" } },
  }, "draft", "approve")).toThrow("undeclared state");
});
