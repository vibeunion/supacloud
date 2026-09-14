import type { SupabaseClient } from "@supabase/supabase-js";
import { invokeCommandRpc } from "./command-rpc.js";
import { captureCommandId, decodeCommandRead, SupaCloudCommandReadError } from "./command-read.js";
import { captureCommandSubmit, decodeCommandSubmit, SupaCloudCommandSubmitError } from "./command-submit.js";
import type { SupaCloudWorkflowJson, SupaCloudWorkflowRun } from "./workflows.js";
export { SupaCloudCommandReadError } from "./command-read.js";
export { SupaCloudCommandSubmitError } from "./command-submit.js";

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

  async submit(request: SupaCloudCommandSubmitRequest): Promise<SupaCloudCommandReceipt> {
    const captured = captureCommandSubmit(request);
    const result = await invokeCommandRpc(
      this.supabase, "supacloud_command_submit", captured, () => new SupaCloudCommandSubmitError(true),
    );
    return decodeCommandSubmit(result, captured);
  }

  async get(commandId: string): Promise<SupaCloudCommandReceipt | null> {
    const captured = captureCommandId(commandId);
    const result = await invokeCommandRpc(this.supabase, "supacloud_command_get", {
      commandId: captured,
    }, () => new SupaCloudCommandReadError());
    return decodeCommandRead(result, captured);
  }
}
