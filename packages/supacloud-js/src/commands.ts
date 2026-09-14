import { decodeCommandStatus, type CommandLookup, type CommandStatus } from "@supacloud/contracts";
import { SupaCloudApiError } from "./api-error.js";

export class SupaCloudCommandReadError extends SupaCloudApiError {
  readonly mutationMayHaveApplied = false;

  constructor() {
    super("Command read could not be validated", 0, {
      code: "COMMAND_READ_INVALID", mutation_may_have_applied: false,
    });
    this.name = "SupaCloudCommandReadError";
  }
}

export class SupaCloudCommandSubmitError extends SupaCloudApiError {
  constructor(readonly mutationMayHaveApplied = true) {
    super("Command submission could not be validated", 0, {
      code: "COMMAND_SUBMIT_UNCONFIRMED", mutation_may_have_applied: mutationMayHaveApplied,
    });
    this.name = "SupaCloudCommandSubmitError";
  }
}

/** Narrow, validated boundary compatible with the Supabase RPC client. */
export interface CommandRpcClient {
  rpc(functionName: string, args: { request: object }): PromiseLike<{
    data: unknown;
    error: unknown;
    status?: number;
  }>;
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
    const raw = await this.request("supacloud_command_submit", request, () => new SupaCloudCommandSubmitError());
    const status = decodeCommandStatus(raw);
    if (status.commandId !== request.commandId.toLowerCase()) throw new TypeError("Invalid command submission");
    return status;
  }

  async get(lookup: string | CommandLookup): Promise<SupaCloudCommandReceipt | null> {
    const request: CommandLookup = typeof lookup === "string" ? { commandId: lookup } : { ...lookup };
    const raw = await this.request("supacloud_command_get", request, () => new SupaCloudCommandReadError());
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

  private async request(functionName: string, request: object, failure: () => Error): Promise<unknown> {
    let result: { data: unknown; error: unknown; status?: number };
    try {
      result = await this.supabase.rpc(functionName, { request });
    } catch {
      throw failure();
    }
    if (result.error) {
      const error = result.error;
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code : null;
      if (result.status === 0 || (result.status === undefined && !code)) throw failure();
      throw error;
    }
    return result.data;
  }
}
