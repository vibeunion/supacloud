// Port Guard — intercepts all port-listening APIs to prevent user functions
// from binding ports. Edge Functions receive requests via postMessage, not ports.

if (globalThis.Bun) {
  (globalThis.Bun as Record<string, unknown>).serve = (opts: unknown) => {
    console.warn(
      "[PortGuard] Bun.serve() intercepted — Edge Functions do not need to listen on ports",
    );
    const fetch =
      opts && typeof opts === "object" && "fetch" in opts
        ? (opts as { fetch: unknown }).fetch
        : undefined;
    return { stop: () => {}, port: 0, hostname: "", fetch };
  };

  (globalThis.Bun as Record<string, unknown>).listen = (..._args: unknown[]) => {
    console.warn(
      "[PortGuard] Bun.listen() intercepted — Edge Functions cannot bind ports",
    );
    throw new Error("Bun.listen() is blocked in Edge Functions. Use fetch() for HTTP requests.");
  };
}

const http = require("node:http");
const https = require("node:https");

const mockServer = {
  listen: (...args: unknown[]) => {
    console.warn("[PortGuard] http.listen() intercepted");
    const cb = args.find((a) => typeof a === "function") as
      | Function
      | undefined;
    if (cb) cb();
    return mockServer;
  },
  on: () => mockServer,
  once: () => mockServer,
  close: (cb?: Function) => {
    if (cb) cb();
  },
  address: () => ({ port: 0, address: "0.0.0.0" }),
};

http.createServer = () => mockServer;
https.createServer = () => mockServer;

const net = require("node:net");
net.createServer = () => {
  console.warn("[PortGuard] net.createServer() intercepted");
  return mockServer;
};

try {
  const dgram = require("node:dgram");
  dgram.createSocket = (..._args: unknown[]) => {
    console.warn("[PortGuard] dgram.createSocket() intercepted — UDP sockets blocked");
    throw new Error("UDP sockets are blocked in Edge Functions.");
  };
} catch {
  // dgram may not be available in all environments
}

console.log("[PortGuard] Port listening interception enabled (enhanced)");
