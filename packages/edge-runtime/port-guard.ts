// Port Guard — intercepts all port-listening APIs to prevent user functions
// from binding ports. Edge Functions receive requests via postMessage, not ports.

// 1. Intercept Bun.serve()
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
}

// 2. Intercept node:http / node:https
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

// 3. Intercept node:net
const net = require("node:net");
net.createServer = () => {
  console.warn("[PortGuard] net.createServer() intercepted");
  return mockServer;
};

console.log("[PortGuard] Port listening interception enabled");
