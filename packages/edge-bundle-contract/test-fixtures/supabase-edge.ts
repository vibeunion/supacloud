import { createClient } from "@supabase/supabase-js";

const client = createClient("https://example.supabase.co", "test-key");

export default {
  fetch() {
    return Response.json({ ready: Boolean(client) });
  },
};
