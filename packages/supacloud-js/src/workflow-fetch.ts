import { createBoundedRpcFetch, type FetchTransport } from "./bounded-rpc-fetch.js";

export interface SupaCloudWorkflowFetchOptions {
  fetch?: FetchTransport;
}

const workflowPath = /\/rpc\/supacloud_workflow_(?:start|claim|advance|complete|retry|fail|cancel|get|events)$/;

/**
 * Install in createClient's global.fetch before constructing the Supabase client.
 * Only workflow RPCs are bounded; other Supabase requests pass through unchanged.
 */
export function createSupaCloudWorkflowFetch(options: SupaCloudWorkflowFetchOptions = {}): FetchTransport {
  return createBoundedRpcFetch(
    workflowPath, () => new Error("Workflow HTTP response could not be validated"), options.fetch,
  );
}
