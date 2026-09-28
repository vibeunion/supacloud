import { relativeImportPath } from "./util";
import { APPLICATION_RUNTIME_PROBE_PATH, renderDeliveryRuntimeIdentity } from "./delivery-readiness";

/** Append a typed host boundary without changing the target's module ownership. */
export function renderDeliveryHttpEntry(generatedDirectory: string, hostPath: string): string {
  const specifier = relativeImportPath(generatedDirectory, hostPath);
  return `
import { serve as serveDeliveryHttp } from "bun";
import deliveryProcess from "node:process";
import { createDeliveryApplication } from ${JSON.stringify(specifier)};
${renderDeliveryRuntimeIdentity()}

interface DeliveryHttpHost {
  fetch(request: Request): Response | Promise<Response>;
  close(): void | Promise<void>;
  ready?(): boolean | Promise<boolean>;
}

async function startDeliveryHttp(signal: AbortSignal, shutdownTimeout: number, startDeadline: () => void) {
  const identity = deliveryRuntimeIdentity("http");
  const port = Number(deliveryProcess.env.PORT ?? "3000");
  const hostname = deliveryProcess.env.HOST ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 0 || port > 65535 || hostname.length === 0) {
    throw new Error("Invalid delivery HTTP listener configuration.");
  }
  const createHost: (
    modules: ReturnType<typeof createCompiledModules>, lifecycle: { signal: AbortSignal },
  ) => DeliveryHttpHost | Promise<DeliveryHttpHost> = createDeliveryApplication;
  const host = await createHost(createCompiledModules(), { signal });
  if (!host || typeof host.close !== "function") {
    throw new Error("Invalid delivery HTTP host.");
  }
  let closing: Promise<void> | undefined;
  const closeHost = () => {
    startDeadline();
    return closing ??= Promise.resolve().then(() => host.close());
  };
  if (typeof host.fetch !== "function") {
    await closeHost();
    throw new Error("Invalid delivery HTTP host.");
  }
  if (host.ready !== undefined && typeof host.ready !== "function") {
    await closeHost();
    throw new Error("Invalid delivery HTTP readiness hook.");
  }
  if (signal.aborted) { await closeHost(); return undefined; }
  let server: ReturnType<typeof serveDeliveryHttp>;
  try {
    server = serveDeliveryHttp({
      hostname, port,
      development: false,
      fetch: async (request) => {
        if (identity && new URL(request.url).pathname === ${JSON.stringify(APPLICATION_RUNTIME_PROBE_PATH)}) {
          if (request.method !== "GET") return new Response(null, { status: 405 });
          const ready = !signal.aborted && (host.ready ? await host.ready() === true : true) && !signal.aborted;
          return Response.json({ identity, ready }, {
            status: ready ? 200 : 503, headers: { "cache-control": "no-store" },
          });
        }
        return host.fetch(request);
      },
      error: () => new Response("Internal Server Error", { status: 500 }),
    });
  } catch {
    await closeHost();
    throw new Error("Delivery HTTP listener failed.");
  }
  let stopping: Promise<void> | undefined;
  return {
    url: server.url,
    stop() {
      stopping ??= (async () => {
        let forced = false;
        const drainLimit = setTimeout(() => {
          forced = true;
          void server.stop(true).catch(() => {});
        }, Math.max(1, Math.floor(shutdownTimeout / 2)));
        // Forced connection closure is not a successful graceful shutdown.
        try { await server.stop(false); }
        finally { clearTimeout(drainLimit); await closeHost(); }
        if (forced) throw new Error("Delivery HTTP drain deadline exceeded.");
      })();
      return stopping;
    },
  };
}

{
  const lifecycle = new AbortController();
  const shutdownTimeout = Number(deliveryProcess.env.SHUTDOWN_TIMEOUT_MS ?? "10000");
  let running: Awaited<ReturnType<typeof startDeliveryHttp>>;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const finish = (failed: boolean) => {
    clearTimeout(deadline);
    deliveryProcess.removeListener("SIGINT", requestShutdown);
    deliveryProcess.removeListener("SIGTERM", requestShutdown);
    deliveryProcess.exit(failed ? 1 : 0);
  };
  const stop = () => {
    void running?.stop().then(
      () => finish(false),
      () => { console.error("Delivery HTTP shutdown failed."); finish(true); },
    );
  };
  const startDeadline = () => {
    if (deadline !== undefined) return;
    deadline = setTimeout(() => {
      console.error("Delivery HTTP shutdown deadline exceeded.");
      finish(true);
    }, shutdownTimeout);
  };
  const requestShutdown = () => {
    if (lifecycle.signal.aborted) return;
    // Start the deadline before invoking user-owned abort listeners.
    startDeadline();
    lifecycle.abort();
    stop();
  };
  try {
    if (!Number.isInteger(shutdownTimeout) || shutdownTimeout < 1 || shutdownTimeout > 300000) {
      throw new Error("Invalid delivery HTTP shutdown configuration.");
    }
    deliveryProcess.on("SIGINT", requestShutdown);
    deliveryProcess.on("SIGTERM", requestShutdown);
    running = await startDeliveryHttp(lifecycle.signal, shutdownTimeout, startDeadline);
    if (lifecycle.signal.aborted) {
      if (running) stop();
      else finish(false);
    } else if (running) {
      console.log(JSON.stringify({ event: "delivery-http-listening", url: running.url.href }));
    }
  } catch {
    console.error("Delivery HTTP startup failed.");
    finish(true);
  }
}
`;
}
