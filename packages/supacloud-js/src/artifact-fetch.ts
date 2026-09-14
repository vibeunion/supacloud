import { createBoundedRpcFetch, type FetchTransport } from "./bounded-rpc-fetch.js";

export interface SupaCloudArtifactFetchOptions {
  fetch?: FetchTransport;
}

const artifactPath = /\/rpc\/supacloud_artifact_(?:register|get|link)$/;

/** Bound artifact RPC receipts without imposing limits on Storage file transfers. */
export function createSupaCloudArtifactFetch(options: SupaCloudArtifactFetchOptions = {}): FetchTransport {
  return createBoundedRpcFetch(
    artifactPath, () => new Error("Artifact HTTP response could not be validated"), options.fetch,
  );
}
