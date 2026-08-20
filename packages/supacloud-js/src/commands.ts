import type { SupabaseClient } from "@supabase/supabase-js";
import { invokeServiceRoleRpc } from "./service-role-rpc.js";
import type { SupaCloudWorkflowJson, SupaCloudWorkflowRun } from "./workflows.js";

export interface SupaCloudCommandSubmitRequest {
  commandId: string;
  commandType: string;
  targetType: string;
  targetId: string;
  actorId?: string;
  payload?: SupaCloudWorkflowJson;
  maxAttempts?: number;
}

export interface SupaCloudCommandReceipt {
  commandId: string;
  commandType: string;
  targetType: string;
  targetId: string;
  actorId: string | null;
  payloadFingerprint: string;
  createdAt: string;
  idempotent: boolean;
  workflow: SupaCloudWorkflowRun;
}

/**
 * Service-role-only transactional command receipt client. Application-owned
 * database RPCs can call `supacloud_commands.submit` directly inside a larger
 * transaction when the domain write and durable enqueue must commit together.
 */
export class SupaCloudCommandsClient<TClient extends SupabaseClient = SupabaseClient> {
  constructor(private readonly supabase: TClient) {}

  submit(request: SupaCloudCommandSubmitRequest): Promise<SupaCloudCommandReceipt> {
    return invokeServiceRoleRpc(this.supabase, "supacloud_command_submit", request);
  }

  get(commandId: string): Promise<SupaCloudCommandReceipt | null> {
    return invokeServiceRoleRpc(this.supabase, "supacloud_command_get", {
      commandId,
    });
  }
}
