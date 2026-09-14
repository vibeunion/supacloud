import type { SupabaseClient } from "@supabase/supabase-js";

export async function invokeArtifactRpc(
  supabase: SupabaseClient,
  name: "supacloud_artifact_get" | "supacloud_artifact_register" | "supacloud_artifact_link",
  request: object,
  failure: () => Error,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(failure()); controller.abort(); }, 15000);
  });
  let result: { data: unknown; error: unknown; status: number };
  try {
    const pending = supabase.rpc(name, { request }).retry(false).abortSignal(controller.signal);
    result = await Promise.race([pending, deadline]);
  } catch {
    throw failure();
  } finally {
    clearTimeout(timer);
  }
  if (result.error && result.status >= 400 && result.status < 500) throw result.error;
  if (result.error || result.status !== 200) throw failure();
  return result.data;
}
