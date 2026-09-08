import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { readFunctionFile } from "./trusted-function-files";
import { parseEdgeFunctionActivationManifest } from "./function-activation";

const PROJECT_RELEASE_FILE = ".project-release.json";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function releaseMembers(raw: string, projectRef: string) {
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("Release manifest exceeds 1 MiB");
  const document = JSON.parse(raw);
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("Invalid release manifest");
  const { _supacloud_activation: authority, ...release } = document;
  const parsed = parseEdgeFunctionActivationManifest(JSON.stringify({ version: "1", _supacloud_activation: authority }));
  if (!parsed.authority || parsed.authority.target_state !== "active"
    || release.schema !== "supacloud.project-function-release.v1" || release.project_ref !== projectRef
    || !UUID.test(release.mutation_id) || release.mutation_id !== parsed.authority.activation_id
    || typeof release.request_fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(release.request_fingerprint)
    || createHash("sha256").update(canonicalJson(release)).digest("hex") !== parsed.authority.artifact_sha256
    || !release.members || typeof release.members !== "object" || Array.isArray(release.members)) {
    throw new Error("Release manifest identity or digest is invalid");
  }
  const entries = Object.entries(release.members);
  if (entries.length < 1 || entries.length > 128) throw new Error("Invalid release member count");
  const members = new Map<string, ReturnType<typeof parseEdgeFunctionActivationManifest>>();
  for (const [slug, rawMember] of entries) {
    const member = rawMember as { config?: Record<string, unknown>; authority?: unknown } | null;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(slug) || slug === "_project-release" || !member?.config || !member.authority) {
      throw new Error("Invalid release member");
    }
    const manifest = parseEdgeFunctionActivationManifest(JSON.stringify({
      ...member.config, _supacloud_activation: member.authority,
    }));
    if (manifest.authority?.target_state !== "active" || !manifest.config.version
      || !/^[1-9]\d*$/.test(manifest.config.version) || !Number.isSafeInteger(Number(manifest.config.version))) {
      throw new Error("Release member must identify an immutable positive version");
    }
    members.set(slug, manifest);
  }
  return members;
}

export async function projectReleaseFunctionManifest(projectRoot: string, slug: string) {
  let bytes: Buffer;
  try {
    bytes = (await readFunctionFile(join(projectRoot, PROJECT_RELEASE_FILE))).bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return releaseMembers(bytes.toString("utf8"), basename(projectRoot)).get(slug) ?? null;
}
