import type { SupabaseClient } from "@supabase/supabase-js";
import { captureArtifactId, decodeArtifactRead, SupaCloudArtifactReadError } from "./artifact-read.js";
import { captureArtifactRegister, decodeArtifactRegister, SupaCloudArtifactRegisterError } from "./artifact-register.js";
import { invokeArtifactRpc } from "./artifact-rpc.js";
import { captureArtifactLink, decodeArtifactLink, SupaCloudArtifactLinkError } from "./artifact-link.js";
export { SupaCloudArtifactReadError } from "./artifact-read.js";
export { SupaCloudArtifactRegisterError } from "./artifact-register.js";
export { SupaCloudArtifactLinkError } from "./artifact-link.js";

export type SupaCloudArtifactJson = Record<string, unknown>;

export interface SupaCloudArtifactParent {
  artifactId: string;
  relationType: string;
  metadata: SupaCloudArtifactJson;
  createdAt: string;
}

export interface SupaCloudArtifact {
  artifactId: string;
  bucketId: string;
  objectPath: string;
  objectVersion: string;
  artifactType: string;
  sha256: string;
  sizeBytes: string;
  mimeType: string;
  metadata: SupaCloudArtifactJson;
  retentionUntil: string | null;
  createdBy: string | null;
  createdAt: string;
  idempotent: boolean;
  parents: SupaCloudArtifactParent[];
}

export interface SupaCloudArtifactRegisterRequest {
  artifactId: string;
  bucketId: string;
  objectPath: string;
  artifactType: string;
  sha256: string;
  sizeBytes: string | number;
  mimeType: string;
  metadata?: SupaCloudArtifactJson;
  retentionUntil?: string;
  createdBy?: string;
}

export interface SupaCloudArtifactLinkRequest {
  parentArtifactId: string;
  childArtifactId: string;
  relationType: string;
  metadata?: SupaCloudArtifactJson;
}

/** Service-role-only immutable Storage artifact registry client. */
export class SupaCloudArtifactsClient<TClient extends SupabaseClient = SupabaseClient> {
  constructor(private readonly supabase: TClient) {}

  async register(request: SupaCloudArtifactRegisterRequest): Promise<SupaCloudArtifact> {
    const captured = captureArtifactRegister(request);
    const result = await invokeArtifactRpc(
      this.supabase, "supacloud_artifact_register", captured, () => new SupaCloudArtifactRegisterError(true),
    );
    return decodeArtifactRegister(result, captured);
  }

  async get(artifactId: string): Promise<SupaCloudArtifact | null> {
    const captured = captureArtifactId(artifactId);
    const result = await invokeArtifactRpc(this.supabase, "supacloud_artifact_get", {
      artifactId: captured,
    }, () => new SupaCloudArtifactReadError());
    return decodeArtifactRead(result, captured);
  }

  async link(request: SupaCloudArtifactLinkRequest): Promise<SupaCloudArtifact> {
    const captured = captureArtifactLink(request);
    const result = await invokeArtifactRpc(
      this.supabase, "supacloud_artifact_link", captured, () => new SupaCloudArtifactLinkError(true),
    );
    return decodeArtifactLink(result, captured);
  }
}
