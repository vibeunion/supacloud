import { applicationReleaseId, type ApplicationReleaseRecord } from "@supacloud/delivery";
import type { ApplicationRuntimeInput } from "../../src/services/application-runtime";

export function runtimeInput(): ApplicationRuntimeInput {
  const release: ApplicationReleaseRecord = {
    schema: "supacloud.application-release.v1",
    project_ref: "demo", application_id: "reviews",
    manifest_sha256: "a".repeat(64),
    release_id: applicationReleaseId("demo", "reviews", "a".repeat(64)),
    created_at: "2026-09-26T00:00:00.000Z",
    targets: [
      { name: "api", kind: "http", object_id: "b".repeat(64), entrypoint: "bundle/index.js" },
      { name: "jobs", kind: "worker", object_id: "c".repeat(64), entrypoint: "bundle/index.js" },
    ],
  };
  return {
    release, activationId: "01234567-89ab-4def-8123-456789abcdef",
    environmentId: "test", ports: { api: 31000 },
  };
}
