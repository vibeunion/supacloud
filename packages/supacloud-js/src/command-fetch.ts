import { createBoundedRpcFetch, type FetchTransport } from "./bounded-rpc-fetch.js";

export interface SupaCloudCommandFetchOptions {
  fetch?: FetchTransport;
}

const commandPath = /\/rpc\/supacloud_command_(?:submit|get)$/;

/** Install in Supabase's global.fetch to bound command responses before JSON parsing. */
export function createSupaCloudCommandFetch(options: SupaCloudCommandFetchOptions = {}): FetchTransport {
  return createBoundedRpcFetch(
    commandPath, () => new Error("Command HTTP response could not be validated"), options.fetch,
  );
}
