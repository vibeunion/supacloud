import type { SupabaseClient } from "@supabase/supabase-js";

type ServiceRoleRpcClient = {
  rpc(
    rpcName: string,
    params: { request: object },
  ): Promise<{ data: unknown; error: unknown }>;
};

export async function invokeServiceRoleRpc<T>(
  supabase: SupabaseClient,
  functionName: string,
  request: object,
): Promise<T> {
  const rpcClient = supabase as unknown as ServiceRoleRpcClient;
  const { data: rpcResponse, error: rpcError } = await rpcClient.rpc(
    functionName,
    { request },
  );
  if (rpcError) throw rpcError;
  return rpcResponse as T;
}
