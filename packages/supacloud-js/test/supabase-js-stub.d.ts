export interface SupabaseClient {
  rpc(functionName: string, args: { request: object }): PromiseLike<{ data: unknown; error: unknown }>;
}
