import type { SupabaseClient } from "@supabase/supabase-js";
import { invokeServiceRoleRpc } from "./service-role-rpc.js";

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

  register(request: SupaCloudArtifactRegisterRequest): Promise<SupaCloudArtifact> {
    return invokeServiceRoleRpc(this.supabase, "supacloud_artifact_register", request);
  }

  get(artifactId: string): Promise<SupaCloudArtifact | null> {
    return invokeServiceRoleRpc(this.supabase, "supacloud_artifact_get", {
      artifactId,
    });
  }

  link(request: SupaCloudArtifactLinkRequest): Promise<SupaCloudArtifact> {
    return invokeServiceRoleRpc(this.supabase, "supacloud_artifact_link", request);
  }
}
