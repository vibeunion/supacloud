import { branchService } from "../services/branch.service";
import { logger } from "../utils/logger";

const RECOVERY_INTERVAL_MS = 60_000;
let recoveryTimer: ReturnType<typeof setInterval> | null = null;

async function runRecoverySweep(): Promise<void> {
  try {
    const result = await branchService.recoverInterruptedReplacements();
    if (result.checked > 0) {
      logger.info("[BranchReplacementRecovery] recovery sweep completed", result);
    }
  } catch (error: unknown) {
    logger.error("[BranchReplacementRecovery] recovery sweep failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function startBranchReplacementRecoveryWorker(): void {
  if (recoveryTimer) return;
  recoveryTimer = setInterval(() => void runRecoverySweep(), RECOVERY_INTERVAL_MS);
}

export function stopBranchReplacementRecoveryWorker(): void {
  if (!recoveryTimer) return;
  clearInterval(recoveryTimer);
  recoveryTimer = null;
}
