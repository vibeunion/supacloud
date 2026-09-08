import { stableSha256 } from "../utils/stable-json";
import {
  EDGE_FUNCTION_ACTIVATION_SCHEMA, parseEdgeFunctionActivationManifest,
  type EdgeFunctionActivationAuthority,
} from "./edge-function-activation-manifest";

export const PROJECT_RELEASE_SCHEMA = "supacloud.project-function-release.v1";
export const PROJECT_RELEASE_FILE = ".project-release.json";
export const PROJECT_RELEASE_SLUG = "_project-release";
export const RELEASE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export type ReleaseMember = { config: Record<string, unknown>; authority: EdgeFunctionActivationAuthority };
export type ProjectRelease = {
  schema: typeof PROJECT_RELEASE_SCHEMA;
  project_ref: string;
  mutation_id: string;
  request_fingerprint: string;
  members: Record<string, ReleaseMember>;
};
export type ProjectReleaseSnapshot = { release: ProjectRelease; authority: EdgeFunctionActivationAuthority };

export function releaseAuthority(release: ProjectRelease, previous: ProjectReleaseSnapshot | null): EdgeFunctionActivationAuthority {
  return {
    schema: EDGE_FUNCTION_ACTIVATION_SCHEMA, activation_id: release.mutation_id,
    activation_generation: (previous?.authority.activation_generation ?? 0) + 1,
    previous_activation_id: previous?.authority.activation_id ?? null,
    target_state: "active", artifact_sha256: stableSha256(release),
  };
}

export function parseProjectRelease(raw: string, projectRef: string): ProjectReleaseSnapshot {
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("Release manifest exceeds 1 MiB");
  const { config, authority } = parseEdgeFunctionActivationManifest(raw);
  if (!authority || config.schema !== PROJECT_RELEASE_SCHEMA || config.project_ref !== projectRef
    || config.mutation_id !== authority.activation_id || !RELEASE_ID.test(String(config.mutation_id))
    || !/^[a-f0-9]{64}$/.test(String(config.request_fingerprint))
    || !config.members || typeof config.members !== "object" || Array.isArray(config.members)
    || stableSha256(config) !== authority.artifact_sha256 || authority.target_state !== "active") {
    throw new Error("Release manifest identity or digest is invalid");
  }
  const entries = Object.entries(config.members);
  if (entries.length < 1 || entries.length > 128) throw new Error("Release must contain 1-128 functions");
  for (const [slug, member] of entries) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(slug) || slug === PROJECT_RELEASE_SLUG
      || !member || typeof member !== "object" || !member.config || !member.authority) {
      throw new Error("Release member is invalid");
    }
    const parsed = parseEdgeFunctionActivationManifest(JSON.stringify({
      ...member.config, _supacloud_activation: member.authority,
    }));
    if (parsed.authority?.target_state !== "active" || typeof parsed.config.version !== "string"
      || !/^[1-9]\d*$/.test(parsed.config.version) || !Number.isSafeInteger(Number(parsed.config.version))) {
      throw new Error("Release member must identify an immutable positive version");
    }
  }
  return { release: config as ProjectRelease, authority };
}
