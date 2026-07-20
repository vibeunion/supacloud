import { processOneWebhookDelivery } from "../services/webhook-delivery.service";
import { logger } from "../utils/logger";

const POLL_INTERVAL_MS = Math.max(250, Number(process.env.WEBHOOK_DELIVERY_POLL_MS || 1_000));
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function sweepWebhookDeliveries(maxItems = 25): Promise<number> {
  if (running) return 0;
  running = true;
  let processed = 0;
  try {
    while (processed < maxItems && await processOneWebhookDelivery()) processed += 1;
  } catch (error: unknown) {
    logger.error("[WebhookDeliveryWorker] Sweep failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    running = false;
  }
  return processed;
}

export function startWebhookDeliveryWorker(): void {
  if (timer) return;
  void sweepWebhookDeliveries();
  timer = setInterval(() => void sweepWebhookDeliveries(), POLL_INTERVAL_MS);
  timer.unref?.();
  logger.info(`[WebhookDeliveryWorker] Started (${POLL_INTERVAL_MS}ms poll)`);
}

export function stopWebhookDeliveryWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  logger.info("[WebhookDeliveryWorker] Stopped");
}
