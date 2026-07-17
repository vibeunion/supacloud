import {
  createSupaCloudOAuthFetch,
  type SupaCloudOAuthFetchOptions,
} from "@supacloud/js";

const options = {
  clientId: "public-client",
} satisfies SupaCloudOAuthFetchOptions;

void createSupaCloudOAuthFetch(options);
