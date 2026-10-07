import { validateJobKey } from "./job-policy.js";

export interface PgmqWakeupTransport {
  notify(channel: string, payload: string): Promise<void>;
  wait(channel: string, signal: AbortSignal): Promise<void>;
}

export function pgmqWakeupChannel(queueName: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(queueName)) {
    throw new Error("WORKER_QUEUE_INVALID");
  }
  return `supacloud_pgmq_${queueName}`;
}

export function createPgmqWakeup(
  transport: PgmqWakeupTransport,
  queueName: string,
) {
  const channel = pgmqWakeupChannel(queueName);
  return {
    channel,
    async signal(jobKey?: string): Promise<void> {
      const payload = jobKey === undefined ? "" : validateJobKey(jobKey);
      await transport.notify(channel, payload);
    },
    wait(signal: AbortSignal): Promise<void> {
      return transport.wait(channel, signal);
    },
  };
}
