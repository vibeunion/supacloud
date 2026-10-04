import { relativeImportPath } from "./util";
import { renderDeliveryRuntimeIdentity } from "./delivery-readiness";

/** The host owns polling and receipts; this entry owns only process lifetime. */
export function renderDeliveryWorkerEntry(generatedDirectory: string, hostPath: string): string {
  const specifier = relativeImportPath(generatedDirectory, hostPath);
  return `
import deliveryProcess from "node:process";
import { isDeepStrictEqual as deliveryPolicyEqual } from "node:util";
import { createDeliveryWorker } from ${JSON.stringify(specifier)};
${renderDeliveryRuntimeIdentity()}

interface DeliveryWorkerHost {
  start(): void | Promise<void>;
  close(): void | Promise<void>;
  failure?: Promise<never>;
  execution?: unknown;
  health?(): Promise<{ ready: boolean; active: number; completed: number; failed: number; timedOut: number }>;
}

{
  const lifecycle = new AbortController();
  const shutdownTimeout = Number(deliveryProcess.env.SHUTDOWN_TIMEOUT_MS ?? "10000");
  let host: DeliveryWorkerHost | undefined;
  let running = false;
  let runtimeFailed = false;
  let closing: Promise<void> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let healthPending = false;
  const finish = (failed: boolean) => {
    clearTimeout(deadline);
    clearInterval(keepAlive);
    deliveryProcess.removeListener("SIGINT", requestShutdown);
    deliveryProcess.removeListener("SIGTERM", requestShutdown);
    deliveryProcess.removeListener("uncaughtException", runtimeFailure);
    deliveryProcess.removeListener("unhandledRejection", runtimeFailure);
    deliveryProcess.exit(failed ? 1 : 0);
  };
  const startDeadline = () => {
    if (deadline !== undefined) return;
    deadline = setTimeout(() => {
      console.error("Delivery worker shutdown deadline exceeded.");
      finish(true);
    }, shutdownTimeout);
  };
  const closeHost = () => {
    startDeadline();
    return closing ??= Promise.resolve().then(() => host?.close());
  };
  const finishShutdown = async () => {
    await closeHost();
    // Observe errors queued by abort listeners before declaring graceful shutdown.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    finish(runtimeFailed);
  };
  const requestShutdown = () => {
    if (lifecycle.signal.aborted) return;
    startDeadline();
    try { lifecycle.abort(); }
    catch { runtimeFailed = true; console.error("Delivery worker runtime failed."); }
    // A host may need close() to unblock start(). Success still waits for start.
    if (host) void closeHost().catch(() => { runtimeFailed = true; });
    if (running) {
      void finishShutdown().catch(() => {
        console.error("Delivery worker shutdown failed.");
        finish(true);
      });
    }
  };
  const runtimeFailure = () => {
    runtimeFailed = true;
    console.error("Delivery worker runtime failed.");
    requestShutdown();
  };
  try {
    const identity = deliveryRuntimeIdentity("worker");
    if (!Number.isInteger(shutdownTimeout) || shutdownTimeout < 1 || shutdownTimeout > 300000) {
      throw new Error("Invalid delivery worker shutdown configuration.");
    }
    deliveryProcess.on("SIGINT", requestShutdown);
    deliveryProcess.on("SIGTERM", requestShutdown);
    deliveryProcess.on("uncaughtException", runtimeFailure);
    deliveryProcess.on("unhandledRejection", runtimeFailure);
    const createHost: (
      modules: ReturnType<typeof createCompiledModules>, lifecycle: { signal: AbortSignal },
    ) => DeliveryWorkerHost | Promise<DeliveryWorkerHost> = createDeliveryWorker;
    const candidate = await createHost(createCompiledModules(), { signal: lifecycle.signal });
    if (!candidate || typeof candidate.close !== "function") throw new Error("Invalid delivery worker host.");
    host = candidate;
    const execution = deliveryProcess.env.SUPACLOUD_WORKER_EXECUTION;
    if (execution) {
      const expected: unknown = JSON.parse(Buffer.from(execution, "base64").toString("utf8"));
      if (!deliveryPolicyEqual(host.execution, expected) || typeof host.health !== "function" || !host.failure) {
        throw new Error("Delivery worker execution policy was not adopted.");
      }
    }
    if (typeof host.start !== "function") throw new Error("Invalid delivery worker host.");
    if (host.failure !== undefined) {
      if (!host.failure || typeof host.failure.then !== "function") throw new Error("Invalid worker failure signal.");
      // A fulfilled fatal channel is also invalid; neither outcome may leave a dead worker alive.
      void host.failure.then(runtimeFailure, runtimeFailure);
    }
    if (!lifecycle.signal.aborted) await host.start();
    if (lifecycle.signal.aborted) {
      await finishShutdown();
    } else {
      running = true;
      const health = async () => {
        if (!execution || !host?.health || healthPending || lifecycle.signal.aborted) return;
        healthPending = true;
        try {
          const status = await host.health();
          console.log(JSON.stringify({ event: "delivery-worker-health", identity, observedAt: new Date().toISOString(), ...status }));
        } catch {
          console.log(JSON.stringify({ event: "delivery-worker-health", identity, observedAt: new Date().toISOString(), ready: false }));
        } finally { healthPending = false; }
      };
      keepAlive = setInterval(() => { void health(); }, execution ? 5000 : 1000);
      await health();
      console.log(JSON.stringify({ event: "delivery-worker-started", ...(identity ? { identity } : {}) }));
    }
  } catch {
    if (host) {
      try { await closeHost(); }
      catch { console.error("Delivery worker cleanup failed."); }
    }
    console.error("Delivery worker startup failed.");
    finish(true);
  }
}
`;
}
