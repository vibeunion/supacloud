export interface TaskOutputMaintenanceOptions {
  mode: "inspect" | "dry-run" | "apply";
  limit: number;
}

/** No database access while parsing. An empty invocation never deletes data. */
export function taskOutputMaintenanceOptions(args: readonly string[]): TaskOutputMaintenanceOptions {
  let mode: TaskOutputMaintenanceOptions["mode"] = "dry-run";
  let explicitMode = false;
  let explicitLimit = false;
  let limit = 25;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--inspect" || arg === "--dry-run" || arg === "--apply") {
      if (explicitMode) throw new Error("Choose exactly one maintenance mode");
      explicitMode = true;
      mode = arg === "--inspect" ? "inspect" : arg === "--apply" ? "apply" : "dry-run";
    } else if (arg === "--limit") {
      const value = args[++index] ?? "";
      if (explicitLimit || !/^[1-9][0-9]{0,2}$/.test(value) || String(Number(value)) !== value || Number(value) > 100) {
        throw new Error("--limit must be specified once, between 1 and 100");
      }
      explicitLimit = true;
      limit = Number(value);
    } else {
      throw new Error("Unknown maintenance argument");
    }
  }
  if (mode === "inspect" && explicitLimit) throw new Error("--inspect does not accept --limit");
  return { mode, limit };
}

export function taskOutputMaintenanceFingerprint(value: unknown): string {
  if (typeof value !== "string" || value.length !== 64 || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("Set SUPACLOUD_TASK_OUTPUT_CONTROL_FINGERPRINT to the verified physical control-database fingerprint");
  }
  return value;
}
