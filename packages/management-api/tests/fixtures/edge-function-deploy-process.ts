import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

const RUNTIME_INSTANCE_ID = "00000000-0000-4000-8000-000000000001";
const LOADED_REVISION = `hmac-sha256:${"a".repeat(64)}`;
const ENV_PROOF = `hmac-sha256:${"b".repeat(64)}`;
const FOREGROUND_MODULE_PROOF = `hmac-sha256:${"c".repeat(64)}`;
const BACKGROUND_MODULE_PROOF = `hmac-sha256:${"d".repeat(64)}`;

function requiredEnvironment(name: string): string {
  const environmentValue = process.env[name];
  if (!environmentValue) throw new Error(`Missing ${name}`);
  return environmentValue;
}

async function waitForPath(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (existsSync(filePath)) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function activationAcknowledgement(activationId: string, action: string) {
  return {
    schema: "supacloud.edge-runtime-function-activation.v1",
    activation_id: activationId,
    state: action === "begin" ? "fenced" : action === "abort" ? "aborted" : "committed",
    runtime_instance_id: RUNTIME_INSTANCE_ID,
    foreground_generation: action === "begin" ? 1 : 2,
    background_generation: action === "begin" ? 1 : 2,
    cancelled_queued: 0,
  };
}

function preheatPool(attestation: object) {
  return {
    attempted: 1,
    succeeded: 1,
    cacheHits: 0,
    cacheMisses: 1,
    durationMs: 1,
    attestation,
    rotation: {
      generation: 2,
      attempted: 0,
      idleRetired: 0,
      busyTainted: 0,
      alreadyTainted: 0,
      immediateReplacements: 0,
    },
  };
}

const projectRef = requiredEnvironment("FUNCTION_PROJECT_REF");
const functionSlug = requiredEnvironment("FUNCTION_SLUG");
const readyPath = requiredEnvironment("FUNCTION_READY_PATH");
const startPath = requiredEnvironment("FUNCTION_START_PATH");
const attemptPath = requiredEnvironment("FUNCTION_ATTEMPT_PATH");
const beginPath = requiredEnvironment("FUNCTION_BEGIN_PATH");
const releasePath = requiredEnvironment("FUNCTION_RELEASE_PATH");
const outcomePath = requiredEnvironment("FUNCTION_OUTCOME_PATH");
const codeMarker = requiredEnvironment("FUNCTION_CODE_MARKER");

const {
  edgeFunctionService,
  getVersionedArtifactPath,
} = await import("../../src/services/edge-function.service");

async function preheatAcknowledgement(init?: RequestInit) {
  const headers = new Headers(init?.headers);
  const activationId = headers.get("x-supacloud-activation-id")!;
  const requestedVersion = headers.get("x-supacloud-function-version")!;
  const artifactPath = await getVersionedArtifactPath(projectRef, functionSlug, requestedVersion);
  if (!artifactPath) throw new Error("Prepared Function artifact is unavailable");
  const artifactSha256 = createHash("sha256").update(await readFile(artifactPath)).digest("hex");
  const identity = {
    schema: "supacloud.edge-runtime-preheat-attestation.v1",
    project_ref: projectRef,
    function_slug: functionSlug,
    requested_version: requestedVersion,
    target_version: requestedVersion,
    resolved_version: requestedVersion,
    artifact_sha256: artifactSha256,
    verify_jwt: true,
    activation_id: activationId,
    runtime_instance_id: RUNTIME_INSTANCE_ID,
    tenant_env: {
      loaded_revision: LOADED_REVISION,
      env_proof: ENV_PROOF,
      load_state: "loaded",
      load_source: "management_api",
    },
    module_loaded: true,
  };
  const foreground = {
    ...identity,
    execution_profile: "foreground",
    module_env_proof: FOREGROUND_MODULE_PROOF,
  };
  const background = {
    ...identity,
    execution_profile: "background",
    module_env_proof: BACKGROUND_MODULE_PROOF,
  };
  return {
    preheated: `${projectRef}_${functionSlug}_v${requestedVersion}`,
    version: requestedVersion,
    success: true,
    attestation: foreground,
    foreground: preheatPool(foreground),
    background: preheatPool(background),
  };
}

globalThis.fetch = (async (input, init) => {
  const requestUrl = new URL(String(input));
  const action = requestUrl.pathname.split("/").at(-1)!;
  const activationId = new Headers(init?.headers).get("x-supacloud-activation-id")!;
  if (requestUrl.pathname.includes("/internal/function-activation/")) {
    if (action === "begin") {
      await writeFile(beginPath, "begin");
      await waitForPath(releasePath);
    }
    return Response.json(activationAcknowledgement(activationId, action));
  }
  if (requestUrl.pathname.includes("/preheat/")) {
    return Response.json(await preheatAcknowledgement(init));
  }
  throw new Error(`Unexpected runtime request: ${requestUrl.pathname}`);
}) as typeof fetch;

await writeFile(readyPath, "ready");
await waitForPath(startPath);
await writeFile(attemptPath, "attempt");

const deployment = await edgeFunctionService.deployRelease({
  ref: projectRef,
  slug: functionSlug,
  expectedActiveVersion: "absent",
  expectedActivationId: "legacy",
  code: `export default { fetch: () => new Response(${JSON.stringify(codeMarker)}) };`,
});

await writeFile(outcomePath, JSON.stringify({
  success: deployment.success,
  error_code: deployment.error_code ?? null,
  version: deployment.version ?? null,
  activation_id: deployment.activation_id ?? null,
}));
