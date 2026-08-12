import { describe, expect, test } from "bun:test";
import {
  EDGE_RUNTIME_PREHEAT_ATTESTATION_SCHEMA,
  isEdgeRuntimePreheatIdentity,
  type EdgeRuntimePreheatIdentity,
} from "./preheat-attestation";

function preheatIdentity(requestedVersion: string | null): EdgeRuntimePreheatIdentity {
  return {
    schema: EDGE_RUNTIME_PREHEAT_ATTESTATION_SCHEMA,
    project_ref: "project_ref",
    function_slug: "function_slug",
    requested_version: requestedVersion,
    target_version: requestedVersion,
    resolved_version: requestedVersion,
    artifact_sha256: "a".repeat(64),
    verify_jwt: true,
    activation_id: null,
    runtime_instance_id: "00000000-0000-4000-8000-000000000001",
    execution_profile: "foreground",
    module_env_proof: `hmac-sha256:${"b".repeat(64)}`,
    tenant_env: {
      loaded_revision: `hmac-sha256:${"c".repeat(64)}`,
      env_proof: `hmac-sha256:${"d".repeat(64)}`,
      load_state: "loaded",
      load_source: "management_api",
    },
  };
}

describe("Edge Runtime preheat version validation", () => {
  test.each([null, "0", "1", "9007199254740991"])(
    "accepts canonical safe requested version %j",
    (requestedVersion) => {
      expect(isEdgeRuntimePreheatIdentity(preheatIdentity(requestedVersion))).toBe(true);
    },
  );

  test.each(["00", "01", "-1", "1.5", "9007199254740992"])(
    "rejects non-canonical or unsafe requested version %j",
    (requestedVersion) => {
      expect(isEdgeRuntimePreheatIdentity(preheatIdentity(requestedVersion))).toBe(false);
    },
  );
});
