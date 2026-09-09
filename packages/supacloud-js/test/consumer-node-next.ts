import {
  createSupaCloudOAuthFetch,
  type SupaCloudOAuthFetchOptions,
  type SupaCloudCommandReceipt,
  createSupaCloudClient,
} from "@supacloud/js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createCommandScope } from "@supacloud/contracts/client";
import * as browserContracts from "@supacloud/contracts/browser";

const options = {
  clientId: "public-client",
} satisfies SupaCloudOAuthFetchOptions;

void createSupaCloudOAuthFetch(options);

declare const supabase: SupabaseClient;
const client = createSupaCloudClient({ supabase, managementApiUrl: "https://admin.example.com", projectRef: "project" });
const receipt: Promise<SupaCloudCommandReceipt | null> = client.commands.get({
  tenantId: "tenant", actorId: "actor", command: "update", operationId: "key",
});
void receipt;
void createCommandScope;
void browserContracts;
