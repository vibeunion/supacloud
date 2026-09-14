import { expect, spyOn, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import { createSupaCloudClient, createSupaCloudOAuthFetch } from "./index";

test("the public SDK does not expose unsupported SupAuth orchestration or access credentials at construction", () => {
  const fetchSpy = spyOn(globalThis, "fetch");
  let tokenReads = 0;
  try {
    const supabase = createClient("https://project.example.com", "anon-key", {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    const client = createSupaCloudClient({
      supabase, managementApiUrl: "https://management.example.com", projectRef: "proj_1",
      getAccessToken: () => { tokenReads++; return "management-token"; },
    });
    expect("supauth" in client).toBe(false);
    expect(client.supabase).toBe(supabase);
    expect(typeof client.auth.oauthServer.getStatus).toBe("function");
    expect(typeof client.auth.oauthServer.migrateToOidc).toBe("function");
    expect(typeof client.auth.oauthClients.list).toBe("function");
    expect(typeof createSupaCloudOAuthFetch).toBe("function");
    expect(tokenReads).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally { fetchSpy.mockRestore(); }
});
