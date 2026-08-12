import { describe, expect, test } from "bun:test";
import {
  validateEdgeRuntimePreheat,
  type ExpectedEdgeRuntimePreheat,
} from "../../src/services/edge-runtime-preheat-attestation";

const EXPECTED: ExpectedEdgeRuntimePreheat = {
  projectRef: "proj_attested",
  functionSlug: "fa-api",
  requestedVersion: "12",
  resolvedVersion: "12",
  artifactSha256: "a".repeat(64),
  verifyJwt: true,
  activationId: "00000000-0000-4000-8000-000000000010",
};
const RUNTIME_INSTANCE_ID = "00000000-0000-4000-8000-000000000001";
const LOADED_REVISION = `hmac-sha256:${"b".repeat(64)}`;
const ENV_PROOF = `hmac-sha256:${"c".repeat(64)}`;
const FOREGROUND_MODULE_PROOF = `hmac-sha256:${"d".repeat(64)}`;
const BACKGROUND_MODULE_PROOF = `hmac-sha256:${"e".repeat(64)}`;

function preheatIdentity(overrides: Record<string, unknown> = {}) {
  return {
    schema: "supacloud.edge-runtime-preheat-attestation.v1",
    project_ref: EXPECTED.projectRef,
    function_slug: EXPECTED.functionSlug,
    requested_version: EXPECTED.requestedVersion,
    target_version: EXPECTED.resolvedVersion,
    resolved_version: EXPECTED.resolvedVersion,
    artifact_sha256: EXPECTED.artifactSha256,
    verify_jwt: EXPECTED.verifyJwt,
    activation_id: EXPECTED.activationId,
    runtime_instance_id: RUNTIME_INSTANCE_ID,
    execution_profile: "foreground",
    module_env_proof: FOREGROUND_MODULE_PROOF,
    tenant_env: {
      loaded_revision: LOADED_REVISION,
      env_proof: ENV_PROOF,
      load_state: "loaded",
      load_source: "management_api",
    },
    module_loaded: true,
    ...overrides,
  };
}

function preheatPool(attestation: object) {
  return {
    attempted: 1,
    succeeded: 1,
    cacheHits: 0,
    cacheMisses: 1,
    durationMs: 2,
    attestation,
    rotation: {
      generation: 1,
      attempted: 1,
      idleRetired: 1,
      busyTainted: 0,
      alreadyTainted: 0,
      immediateReplacements: 1,
    },
  };
}

function preheatResponse() {
  const attestation = preheatIdentity();
  const backgroundAttestation = preheatIdentity({
    execution_profile: "background",
    module_env_proof: BACKGROUND_MODULE_PROOF,
  });
  return {
    preheated: `${EXPECTED.projectRef}_${EXPECTED.functionSlug}_v${EXPECTED.resolvedVersion}`,
    version: EXPECTED.requestedVersion,
    success: true,
    attestation,
    foreground: preheatPool(attestation),
    background: preheatPool(backgroundAttestation),
  };
}

describe("Edge Runtime preheat attestation", () => {
  test("accepts a canonical worker acknowledgement", () => {
    expect(validateEdgeRuntimePreheat(preheatResponse(), EXPECTED)).toEqual({
      identity: {
        runtimeInstanceId: RUNTIME_INSTANCE_ID,
        loadedRevision: LOADED_REVISION,
        envProof: ENV_PROOF,
        verifyJwt: true,
        activationId: EXPECTED.activationId,
        executionProfile: "foreground",
        moduleEnvProof: FOREGROUND_MODULE_PROOF,
      },
      foreground: {
        attempted: 1,
        succeeded: 1,
        cacheHits: 0,
        cacheMisses: 1,
        durationMs: 2,
        generation: 1,
      },
      background: {
        attempted: 1,
        succeeded: 1,
        cacheHits: 0,
        cacheMisses: 1,
        durationMs: 2,
        generation: 1,
      },
    });
  });

  test.each([
    ["extra response key", () => ({ ...preheatResponse(), extra: true })],
    ["wrong project", () => ({ ...preheatResponse(), attestation: preheatIdentity({ project_ref: "other" }) })],
    ["wrong artifact hash", () => ({ ...preheatResponse(), attestation: preheatIdentity({ artifact_sha256: "d".repeat(64) }) })],
    ["wrong requested version", () => ({ ...preheatResponse(), version: "13" })],
    ["invalid runtime instance", () => ({ ...preheatResponse(), attestation: preheatIdentity({ runtime_instance_id: "not-a-uuid" }) })],
    ["wrong authorization policy", () => ({ ...preheatResponse(), attestation: preheatIdentity({ verify_jwt: false }) })],
    ["wrong activation identity", () => ({
      ...preheatResponse(),
      attestation: preheatIdentity({ activation_id: "00000000-0000-4000-8000-000000000011" }),
    })],
    ["top-level module proof split from the foreground pool", () => ({
      ...preheatResponse(),
      attestation: preheatIdentity({ module_env_proof: `hmac-sha256:${"f".repeat(64)}` }),
    })],
    ["unverified environment", () => ({
      ...preheatResponse(),
      attestation: preheatIdentity({
        tenant_env: {
          loaded_revision: null,
          env_proof: null,
          load_state: "unverified",
          load_source: "file_fallback",
        },
      }),
    })],
    ["split pool identity", () => {
      const response = preheatResponse();
      return {
        ...response,
        background: preheatPool(preheatIdentity({
          runtime_instance_id: "00000000-0000-4000-8000-000000000002",
          execution_profile: "background",
          module_env_proof: BACKGROUND_MODULE_PROOF,
        })),
      };
    }],
    ["partially successful foreground pool", () => {
      const response = preheatResponse();
      return {
        ...response,
        foreground: { ...response.foreground, attempted: 2, succeeded: 1 },
      };
    }],
    ["idle background pool", () => {
      const response = preheatResponse();
      return {
        ...response,
        background: {
          ...response.background,
          attempted: 0,
          succeeded: 0,
          cacheMisses: 0,
          attestation: null,
        },
      };
    }],
    ["foreground profile in background pool", () => {
      const response = preheatResponse();
      return {
        ...response,
        background: preheatPool(preheatIdentity()),
      };
    }],
    ["shared foreground and background module proof", () => {
      const response = preheatResponse();
      return {
        ...response,
        background: preheatPool(preheatIdentity({
          execution_profile: "background",
          module_env_proof: FOREGROUND_MODULE_PROOF,
        })),
      };
    }],
    ["impossible rotation disposition total", () => {
      const response = preheatResponse();
      return {
        ...response,
        foreground: {
          ...response.foreground,
          rotation: {
            ...response.foreground.rotation,
            attempted: 4,
          },
        },
      };
    }],
    ["impossible immediate replacement count", () => {
      const response = preheatResponse();
      return {
        ...response,
        background: {
          ...response.background,
          rotation: {
            ...response.background.rotation,
            immediateReplacements: 0,
          },
        },
      };
    }],
  ])("rejects %s", (_name, payload) => {
    expect(validateEdgeRuntimePreheat(payload(), EXPECTED)).toBeNull();
  });
});
