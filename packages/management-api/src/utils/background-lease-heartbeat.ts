/** Non-overlapping, fail-closed heartbeats. Stopping suppresses late callbacks. */
export function startBackgroundLeaseHeartbeat(options: {
  renew: () => Promise<boolean>;
  onLost: (error?: unknown) => void;
  intervalMs?: number;
}): () => void {
  const interval = options.intervalMs ?? 10_000;
  if (!Number.isSafeInteger(interval) || interval < 1) throw new TypeError("Invalid heartbeat interval");
  let stopped = false, inFlight = false;
  const lost = (error?: unknown) => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    options.onLost(error);
  };
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = true;
    void Promise.resolve().then(options.renew).then((renewed) => {
      if (!renewed) lost();
    }, lost).finally(() => { inFlight = false; });
  }, interval);
  return () => { stopped = true; clearInterval(timer); };
}
