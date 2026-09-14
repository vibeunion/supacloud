import { decodeCommandStatus, type CommandLookup, type CommandStatus } from "@supacloud/contracts";

/** Narrow, validated boundary compatible with the Supabase RPC client. */
export interface CommandRpcClient {
  rpc(functionName: string, args: { request: object }): PromiseLike<{ data: unknown; error: unknown }>;
}
export interface SupaCloudCommandSubmitRequest {
  commandId: string;
  commandType: string;
  targetType: string;
  targetId: string;
  actorId?: string;
  /** Required, together with actorId, when binding a submission to a durable executor. */
  tenantId?: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
}

export type SupaCloudCommandReceipt = CommandStatus;

/**
 * Service-role-only transactional command receipt client. Application-owned
 * database RPCs can call `supacloud_commands.submit` directly inside a larger
 * transaction when the domain write and durable enqueue must commit together.
 */
export class SupaCloudCommandsClient<TClient extends CommandRpcClient = CommandRpcClient> {
  constructor(private readonly supabase: TClient) {}

  async submit(request: SupaCloudCommandSubmitRequest): Promise<SupaCloudCommandReceipt> {
    const raw = await this.request("supacloud_command_submit", request);
    const status = decodeCommandStatus(raw);
    if (status.commandId !== request.commandId.toLowerCase()) throw new TypeError("Invalid command submission");
    return status;
  }

  async get(lookup: string | CommandLookup): Promise<SupaCloudCommandReceipt | null> {
    const request: CommandLookup = typeof lookup === "string" ? { commandId: lookup } : { ...lookup };
    const raw = await this.request("supacloud_command_get", request);
    if (raw === null) return null;
    const status = decodeCommandStatus(raw);
    if ("commandId" in request) {
      if (status.commandId !== request.commandId.toLowerCase()) throw new TypeError("Mismatched command status");
    } else {
      if (status.kind !== "execution") throw new TypeError("Missing command execution");
      for (const key of ["tenantId", "actorId", "command", "operationId"] as const) {
        if (status.execution[key] !== request[key]) throw new TypeError("Mismatched command reference");
      }
    }
    return status;
  }

  private async request(functionName: string, request: object): Promise<unknown> {
    const result = await this.supabase.rpc(functionName, { request });
    if (result.error) throw result.error;
    return result.data;
  }
}
