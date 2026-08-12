import { describe, expect, test } from "bun:test";

import {
  parseAbsentFunctionIdentity,
  parseFunctionActivationReceipt,
  parseFunctionConfigReceipt,
  parseFunctionCreateReceipt,
  parseFunctionDeleteReceipt,
} from "./edge-function-mutation-receipts";

const EXPECTED_ACTIVATION_ID = "a1111111-1111-4111-8111-111111111111";
const COMMITTED_ACTIVATION_ID = "b2222222-2222-4222-8222-222222222222";
const OTHER_ACTIVATION_ID = "c3333333-3333-4333-8333-333333333333";

const mutationExpectation = {
  projectRef: "proj",
  slug: "hook",
  expectedActivationId: EXPECTED_ACTIVATION_ID,
};

function versionedReceipt(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    project_ref: "proj",
    slug: "hook",
    previous_active_version: "4",
    active_version: "5",
    version: "5",
    expected_activation_id: EXPECTED_ACTIVATION_ID,
    activation_id: COMMITTED_ACTIVATION_ID,
    config: {
      version: "5",
      verify_jwt: true,
      activation_id: COMMITTED_ACTIVATION_ID,
    },
    ...overrides,
  };
}

function deleteReceipt(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    project_ref: "proj",
    slug: "hook",
    previous_active_version: "4",
    active_version: "absent",
    expected_activation_id: EXPECTED_ACTIVATION_ID,
    activation_id: COMMITTED_ACTIVATION_ID,
    config: {
      verify_jwt: true,
      activation_id: COMMITTED_ACTIVATION_ID,
    },
    ...overrides,
  };
}

describe("Edge Function Web mutation receipts", () => {
  test.each(["legacy", EXPECTED_ACTIVATION_ID])(
    "accepts an absent identity with activation ID %s",
    (activationId) => {
      const identity = parseAbsentFunctionIdentity({
        project_ref: "proj",
        slug: "hook",
        active_version: "absent",
        activation_id: activationId,
        verify_jwt: true,
        background_routes: [],
        private: "identity-private-sentinel",
      }, { projectRef: "proj", slug: "hook" });

      expect(identity).toEqual({ activationId, verifyJwt: true, backgroundRoutes: [] });
      expect(JSON.stringify(identity)).not.toContain("sentinel");
    },
  );

  test.each([
    ["wrong project", { project_ref: "other" }],
    ["wrong slug", { slug: "other" }],
    ["active target", { active_version: "1" }],
    ["versioned tombstone", { version: "1" }],
    ["invalid activation", { activation_id: "invalid" }],
  ])("rejects an absent identity with %s", (_label, override) => {
    expect(() => parseAbsentFunctionIdentity({
      project_ref: "proj",
      slug: "hook",
      active_version: "absent",
      activation_id: EXPECTED_ACTIVATION_ID,
      verify_jwt: true,
      background_routes: [],
      ...override,
    }, { projectRef: "proj", slug: "hook" })).toThrow("Invalid Edge Function mutation response");
  });

  test("accepts a create receipt bound to an absent identity", () => {
    const receipt = parseFunctionCreateReceipt(versionedReceipt({
      previous_active_version: "absent",
    }), mutationExpectation);

    expect(receipt).toEqual({
      activationId: COMMITTED_ACTIVATION_ID,
      activeVersion: "5",
      verifyJwt: true,
    });
  });

  test.each([
    ["wrong project", { project_ref: "other" }],
    ["wrong slug", { slug: "other" }],
    ["wrong previous version", { previous_active_version: "1" }],
    ["mismatched active version", { active_version: "6" }],
    ["mismatched response version", { version: "6" }],
    ["unchanged activation", { activation_id: EXPECTED_ACTIVATION_ID }],
    ["wrong expected activation", { expected_activation_id: OTHER_ACTIVATION_ID }],
  ])("rejects a create receipt with %s", (_label, override) => {
    expect(() => parseFunctionCreateReceipt(versionedReceipt({
      previous_active_version: "absent",
      ...override,
    }), mutationExpectation)).toThrow("Invalid Edge Function mutation response");
  });

  test("accepts an activation receipt bound to previous and target versions", () => {
    const receipt = parseFunctionActivationReceipt(versionedReceipt(), {
      ...mutationExpectation,
      previousActiveVersion: "4",
      targetVersion: "5",
    });

    expect(receipt.activeVersion).toBe("5");
    expect(receipt.activationId).toBe(COMMITTED_ACTIVATION_ID);
  });

  test.each([
    ["wrong previous version", { previousActiveVersion: "3", targetVersion: "5" }],
    ["wrong target version", { previousActiveVersion: "4", targetVersion: "6" }],
  ])("rejects activation expectation with %s", (_label, versions) => {
    expect(() => parseFunctionActivationReceipt(versionedReceipt(), {
      ...mutationExpectation,
      ...versions,
    })).toThrow("Invalid Edge Function mutation response");
  });

  test("accepts an absent deletion receipt", () => {
    expect(parseFunctionDeleteReceipt(deleteReceipt(), {
      ...mutationExpectation,
      previousActiveVersion: "4",
    })).toEqual({ activationId: COMMITTED_ACTIVATION_ID });
  });

  test.each([
    ["wrong project", { project_ref: "other" }],
    ["wrong slug", { slug: "other" }],
    ["active target", { active_version: "5" }],
    ["unchanged activation", { activation_id: EXPECTED_ACTIVATION_ID }],
    ["versioned config", {
      config: {
        version: "5",
        verify_jwt: true,
        activation_id: COMMITTED_ACTIVATION_ID,
      },
    }],
  ])("rejects a deletion receipt with %s", (_label, override) => {
    expect(() => parseFunctionDeleteReceipt(deleteReceipt(override), {
      ...mutationExpectation,
      previousActiveVersion: "4",
    })).toThrow("Invalid Edge Function mutation response");
  });

  test("binds config receipts to project, slug, expected identity, and policy", () => {
    const payload = {
      success: true,
      project_ref: "proj",
      slug: "hook",
      expected_activation_id: EXPECTED_ACTIVATION_ID,
      activation_id: COMMITTED_ACTIVATION_ID,
      verify_jwt: false,
      background_routes: [],
    };
    expect(parseFunctionConfigReceipt(payload, {
      ...mutationExpectation,
      verifyJwt: false,
    })).toEqual({ activationId: COMMITTED_ACTIVATION_ID, verifyJwt: false });
    expect(() => parseFunctionConfigReceipt({ ...payload, slug: "other" }, {
      ...mutationExpectation,
      verifyJwt: false,
    })).toThrow("Invalid Edge Function mutation response");
  });
});
