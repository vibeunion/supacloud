import { CommandError, commandIdentifier, decodeCommandJson, decodeDurableCommandReceipt, type CommandAuthorization, type DurableCommandReceipt } from "@supacloud/contracts";
import { checkAuthorization, type RecoveryPrincipal } from "./context";
import type { CommandRecoveryStore, OperationReference } from "./store";

export interface RecoverableCommand {
  recover(principal: RecoveryPrincipal, reference: OperationReference): Promise<DurableCommandReceipt<unknown> | null>;
}
export interface RecoveryAlert {
  code: "COMMAND_RECOVERY_REQUIRED" | "COMMAND_RECOVERY_FAILED";
  reference: OperationReference;
}
export interface CommandRecoveryReport {
  claimed: number;
  completed: number;
  unresolved: number;
  failed: number;
  redacted: number;
  alerts: RecoveryAlert[];
}

/** A bounded Job handler, not a timer or a new queue. No code path dispatches a write. */
export function createCommandRecoveryJob(options: {
  store: CommandRecoveryStore;
  principal: RecoveryPrincipal;
  tenantId: string;
  commands: Readonly<Record<string, RecoverableCommand>>;
  authorize(): CommandAuthorization | Promise<CommandAuthorization>;
  batchSize: number;
  leaseMs: number;
  retryAfterMs: number;
  alertAfterMs: number;
  inputRetentionMs: number;
  now?: () => number;
}) {
  options = { ...options, principal: { ...options.principal }, commands: { ...options.commands } };
  const tenantId = commandIdentifier(options.tenantId);
  commandIdentifier(options.principal.subject);
  const names = Object.keys(options.commands).map(commandIdentifier);
  if (names.length === 0) throw new TypeError("Recovery requires named commands");
  for (const value of [options.batchSize, options.leaseMs, options.retryAfterMs, options.alertAfterMs, options.inputRetentionMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("Invalid recovery policy");
  }
  if (options.batchSize > 1000) throw new TypeError("Recovery batches are bounded to 1000");
  const scope = { tenantId, commands: names };
  return {
    async run(): Promise<CommandRecoveryReport> {
      await checkAuthorization(options.authorize);
      const now = (options.now ?? Date.now)();
      if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Invalid recovery clock");
      if (!Number.isSafeInteger(now + options.leaseMs) || !Number.isSafeInteger(now + options.retryAfterMs)) {
        throw new TypeError("Recovery timestamp overflow");
      }
      const claims = await options.store.claim({ ...scope, now, limit: options.batchSize, leaseMs: options.leaseMs });
      const report: CommandRecoveryReport = { claimed: claims.length, completed: 0, unresolved: 0, failed: 0, redacted: 0, alerts: [] };
      for (const claim of claims) {
        if (claim.tenantId !== tenantId || !names.includes(claim.command)) throw new CommandError("COMMAND_RECEIPT_INVALID");
        const reference: OperationReference = {
          tenantId: claim.tenantId, actorId: claim.actorId, command: claim.command, operationId: claim.operationId,
        };
        try {
          const command = Object.hasOwn(options.commands, claim.command) ? options.commands[claim.command] : undefined;
          if (!command) throw new CommandError("COMMAND_RECEIPT_INVALID");
          const raw = await command.recover({ ...options.principal }, reference);
          const receipt = raw === null ? null : decodeDurableCommandReceipt(raw, decodeCommandJson);
          if (receipt !== null) {
            for (const key of ["tenantId", "actorId", "command", "operationId"] as const) {
              if (receipt[key] !== reference[key]) throw new CommandError("COMMAND_RECEIPT_INVALID");
            }
          }
          if (receipt?.status === "confirmed" && receipt.audit === "complete") report.completed++;
          else {
            report.unresolved++;
            if (now - claim.createdAt >= options.alertAfterMs) report.alerts.push({ code: "COMMAND_RECOVERY_REQUIRED", reference });
          }
        } catch {
          report.failed++;
          report.alerts.push({ code: "COMMAND_RECOVERY_FAILED", reference });
        } finally {
          await options.store.release(claim, now + options.retryAfterMs);
        }
      }
      report.redacted = await options.store.redactCompleted({
        ...scope, before: Math.max(0, now - options.inputRetentionMs), limit: options.batchSize,
      });
      return report;
    },
  };
}
