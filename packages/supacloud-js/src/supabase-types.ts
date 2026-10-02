/**
 * Supabase ships separate ESM and CommonJS class declarations. Their protected
 * members are nominally distinct even when the runtime APIs are identical.
 * Preserve the caller's exact client type while accepting either declaration
 * graph. Type-only imports add no CommonJS runtime or duplicated state.
 */
import type { SupabaseClient as EsmSupabaseClient } from "@supabase/supabase-js" with { "resolution-mode": "import" };
import type { SupabaseClient as CommonJsSupabaseClient } from "@supabase/supabase-js"
  with { "resolution-mode": "require" };

export type SupabaseClient = EsmSupabaseClient | CommonJsSupabaseClient;
