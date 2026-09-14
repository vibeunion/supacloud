import { describe, expect, mock, test } from "bun:test";
import { createSupaCloudClient } from "./index";

function artifactClient() {
  const rpc = mock(async (functionName: string, params: { request: object }) => ({
    data: { functionName, params }, error: null,
  }));
  const supabase = { rpc, auth: { getSession: async () => ({ data: { session: null }, error: null }) } };
  return {
    artifacts: createSupaCloudClient({
      supabase: supabase as never,
      managementApiUrl: "http://management-not-used",
      projectRef: "project-ref",
    }).artifacts,
    rpc,
  };
}

describe("SupaCloud artifact registry client", () => {
  test("maps register, get, and lineage link to RPCs", async () => {
    const { artifacts, rpc } = artifactClient();
    await artifacts.register({
      artifactId: "11111111-1111-4111-8111-111111111111",
      bucketId: "reports",
      objectPath: "2026/report.pdf",
      artifactType: "report.pdf",
      sha256: "a".repeat(64),
      sizeBytes: "1024",
      mimeType: "application/pdf",
    });
    await artifacts.get("11111111-1111-4111-8111-111111111111");
    await artifacts.link({
      parentArtifactId: "22222222-2222-4222-8222-222222222222",
      childArtifactId: "11111111-1111-4111-8111-111111111111",
      relationType: "rendered_from",
    });
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc.mock.calls[0]?.[0]).toBe("supacloud_artifact_register");
    expect(rpc.mock.calls[1]?.[0]).toBe("supacloud_artifact_get");
    expect(rpc.mock.calls[2]?.[0]).toBe("supacloud_artifact_link");
  });
});
