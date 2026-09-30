import { createHash } from "node:crypto";
import { PreviewEnvironmentError } from "./preview-environment.service";

/**
 * Deterministic Preview naming and identity, per the Preview v1 contract:
 *
 * - a preview has a stable `preview_ref` (`pr-<n>` or `change-<id>`), never a
 *   raw branch name or short SHA;
 * - every derived resource name carries the project and a bounded slug, and the
 *   full preview identity belongs in metadata/labels too (a name prefix is not
 *   isolation evidence);
 * - the activation identity is UUIDv5 so retries converge.
 */

export const PREVIEW_SLUG_MAX_LENGTH = 48;

/** Preview secret reference wire form: `secret://preview/<project>/<slug>/<name>`. */
export function derivePreviewSecretRef(projectId: string, previewRef: string, secretName: string): string {
  const project = projectSegment(projectId);
  const slug = normalizePreviewSlug(previewRef);
  const name = resourceSegment(secretName);
  return `secret://preview/${project}/${slug}/${name}`;
}

export type PreviewResourceKind = "namespace" | "database" | "queue" | "bucket" | "secret" | "configuration";

function invalid(): never {
  throw new PreviewEnvironmentError("PREVIEW_ENVIRONMENT_INVALID");
}

/** Canonical, bounded, lowercase slug derived from a preview reference. */
export function normalizePreviewSlug(previewRef: string): string {
  if (typeof previewRef !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(previewRef)) invalid();
  const slug = previewRef.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length === 0) invalid();
  if (slug.length <= PREVIEW_SLUG_MAX_LENGTH) return slug;
  const digest = createHash("sha256").update(previewRef).digest("hex").slice(0, 8);
  return `${slug.slice(0, PREVIEW_SLUG_MAX_LENGTH - 9)}-${digest}`;
}

function projectSegment(projectId: string): string {
  if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 64
    || /[\u0000-\u001f\u007f]/.test(projectId)) invalid();
  const segment = projectId.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (segment.length === 0 || segment.length > 40) invalid();
  return segment;
}

function resourceSegment(resourceName: string | undefined): string {
  if (resourceName === undefined) invalid();
  if (typeof resourceName !== "string" || resourceName.length === 0 || resourceName.length > 48
    || /[\u0000-\u001f\u007f]/.test(resourceName)) invalid();
  const segment = resourceName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (segment.length === 0) invalid();
  return segment.slice(0, 48);
}

/**
 * Derive a resource name for one preview resource. `database`, `queue`,
 * `storage` and `secret` are distinct surfaces: SQL names avoid hyphens,
 * buckets allow them, and secrets/configuration use a slash namespace.
 */
export function derivePreviewResourceName(
  kind: PreviewResourceKind,
  projectId: string,
  previewRef: string,
  resourceName?: string,
): string {
  const project = projectSegment(projectId);
  const slug = normalizePreviewSlug(previewRef);
  switch (kind) {
    case "namespace": return `pv_${project}_${slug}`;
    case "database": return `pv_${project}_${slug}_db`;
    case "queue": return `pv_${project}_${slug}_q_${resourceSegment(resourceName)}`;
    case "bucket": return `pv-${project.replace(/_/g, "-")}-${slug}-b-${resourceSegment(resourceName).replace(/_/g, "-")}`;
    case "secret": return `pv/${project}/${slug}/${resourceSegment(resourceName)}`;
    case "configuration": return `pv/${project}/${slug}/config/${resourceSegment(resourceName)}`;
  }
}

const DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/** RFC 4122 UUIDv5 (SHA-1) over a namespace UUID and a name. */
export function uuidV5(namespaceUuid: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(namespaceUuid)) invalid();
  const namespace = Buffer.from(namespaceUuid.replace(/-/g, ""), "hex");
  const bytes = Buffer.from(createHash("sha1").update(namespace).update(name, "utf8").digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Deterministic UUIDv5 helper retained for general namespace derivation.
 *
 * @deprecated Do not use this for preview activation identity. The platform
 * activation contract (`@supacloud/delivery` `ApplicationActivationIdSchema`) is
 * UUIDv4 and is owned by the application-activation service; minting a UUIDv5
 * here would create a second, incompatible activation identity. Preview runs on
 * the existing branch and reuses the platform activation id.
 */
export function derivePreviewActivationId(projectId: string, previewRef: string): string {
  const projectNamespace = uuidV5(DNS_NAMESPACE, `supacloud:project:${projectId}`);
  return uuidV5(projectNamespace, `preview:${previewRef}`);
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, without padding. */
export function base32Lower(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}