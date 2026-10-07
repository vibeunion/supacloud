import { createHash } from "node:crypto";
import { validateJobKey, validateQueueName } from "./job-policy.js";

export interface PgmqWakeupTransport {
  /** Use pg_notify parameters and safely quoted LISTEN identifiers. */
  notify(channel: string, payload: string): Promise<void>;
  /** Own connection cleanup, honor cancellation, and retain polling as a fallback. */
  wait(channel: string, signal: AbortSignal): Promise<void>;
}

export function pgmqWakeupChannel(queueName: string): string {
  // 63 ASCII bytes: bounded by PostgreSQL's default 63-byte identifier limit.
  // Always hash, so long-name hashes cannot collide with the short-name namespace.
  return `supacloud_pgmq_${createHash("sha256").update(validateQueueName(queueName)).digest("hex").slice(0, 48)}`;
}

export function createPgmqWakeup(transport: PgmqWakeupTransport, queueName: string) {
  if (!transport || typeof transport.notify !== "function" || typeof transport.wait !== "function") {
    throw new Error("WORKER_WAKEUP_TRANSPORT_INVALID");
  }
  const channel = pgmqWakeupChannel(queueName);
  const notify = transport.notify.bind(transport);
  const wait = transport.wait.bind(transport);
  return {
    channel,
    async signal(jobKey?: string): Promise<void> {
      await notify(channel, jobKey === undefined ? "" : validateJobKey(jobKey));
    },
    async wait(signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      await wait(channel, signal);
      signal.throwIfAborted();
    },
  };
}
