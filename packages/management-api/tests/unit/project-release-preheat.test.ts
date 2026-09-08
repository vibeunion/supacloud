import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(homedir(), ".supacloud-release-preheat-"));
const oldDirectory = process.env.EDGE_FUNCTIONS_DIR;
process.env.EDGE_FUNCTIONS_DIR = root;
const { edgeFunctionService, prepareProjectReleaseMembers } = await import("../../src/services/edge-function.service");
afterAll(async () => {
  if (oldDirectory === undefined) delete process.env.EDGE_FUNCTIONS_DIR;
  else process.env.EDGE_FUNCTIONS_DIR = oldDirectory;
  await rm(root, { recursive: true, force: true });
});

test("production preparation validates both pools against staged immutable artifacts", async () => {
  const ref = "releasepreheat";
  const staged = new Map<string, { version: string; artifact_sha256: string }>();
  for (const slug of ["one", "two"]) {
    staged.set(slug, await edgeFunctionService.stageVersion({
      ref, slug, code: `export default () => new Response("${slug}");`,
    }));
    expect(await edgeFunctionService.getActiveVersion(ref, slug)).toBe("absent");
  }
  const originalFetch = globalThis.fetch;
  const instance = crypto.randomUUID();
  let corrupt = false;
  let preheats = 0;
  globalThis.fetch = (async (input, init) => {
    expect(init?.redirect).toBe("error");
    const url = new URL(String(input));
    if (url.pathname === "/internal/runtime-activation-epoch") return Response.json({
      project_release_schema: "supacloud.project-function-release.v1",
      runtime_instance_id: instance, foreground_generation: 0, background_generation: 0,
    });
    const slug = url.pathname.split("/").at(-1)!;
    const artifact = staged.get(slug)!;
    expect(url.pathname).toBe(`/preheat/${ref}/${slug}`);
    preheats++;
    const identity = {
      schema: "supacloud.edge-runtime-preheat-attestation.v1", project_ref: ref, function_slug: slug,
      requested_version: artifact.version, target_version: artifact.version, resolved_version: artifact.version,
      artifact_sha256: artifact.artifact_sha256, verify_jwt: true, activation_id: null,
      runtime_instance_id: instance, execution_profile: "foreground",
      module_env_proof: `hmac-sha256:${"c".repeat(64)}`, module_loaded: true,
      tenant_env: { loaded_revision: `hmac-sha256:${"a".repeat(64)}`, env_proof: `hmac-sha256:${"b".repeat(64)}`, load_state: "loaded", load_source: "management_api" },
    };
    const pool = (attestation: object) => ({
      attempted: 1, succeeded: 1, cacheHits: 0, cacheMisses: 1, durationMs: 1, attestation,
      rotation: { generation: 0, attempted: 0, idleRetired: 0, busyTainted: 0, alreadyTainted: 0, immediateReplacements: 0 },
    });
    return Response.json({
      preheated: `${ref}_${slug}_v${artifact.version}`, version: artifact.version, success: true,
      attestation: identity, foreground: pool(identity),
      background: pool({
        ...identity, execution_profile: "background", module_env_proof: `hmac-sha256:${"d".repeat(64)}`,
        project_ref: corrupt ? "foreign" : ref,
      }),
    });
  }) as typeof fetch;
  const functions = [...staged].map(([slug, artifact]) => ({ slug, version: artifact.version, expected_activation_id: "legacy" }));
  try {
    const prepared = await prepareProjectReleaseMembers(ref, functions);
    expect(Object.keys(prepared)).toEqual(["one", "two"]);
    expect(preheats).toBe(2);
    corrupt = true;
    await expect(prepareProjectReleaseMembers(ref, functions)).rejects.toThrow();
    expect(await edgeFunctionService.getActiveVersion(ref, "one")).toBe("absent");
  } finally { globalThis.fetch = originalFetch; }
});
