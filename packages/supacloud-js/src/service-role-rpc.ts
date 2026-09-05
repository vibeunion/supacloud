import type { SupabaseClient } from "@supabase/supabase-js";

export async function invokeServiceRoleRpc<T>(
  supabase: SupabaseClient,
  functionName: string,
  request: object,
): Promise<T> {
  const rpcResult: { data: unknown; error: unknown } = await supabase.rpc(
    functionName,
    { request },
  );
  const { data: rpcResponse, error: rpcError } = rpcResult;
  if (rpcError) throw rpcError;
  return rpcResponse as T;
}
