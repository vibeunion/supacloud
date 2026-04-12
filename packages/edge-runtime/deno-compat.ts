import { stat, readdir, mkdir, rm } from "fs/promises";

let capturedServeHandler: Function | null = null;
export function getCapturedServeHandler() {
  return capturedServeHandler;
}
export function clearCapturedServeHandler() {
  capturedServeHandler = null;
}

(globalThis as Record<string, unknown>).Deno = {
  // Environment variables
  env: {
    get: (k: string) => process.env[k],
    set: (k: string, v: string) => {
      process.env[k] = v;
    },
    delete: (k: string) => {
      delete process.env[k];
    },
    has: (k: string) => k in (process.env as Record<string, unknown>),
    toObject: () => ({ ...process.env }),
  },

  // Filesystem
  readTextFile: (p: string) => Bun.file(p).text(),
  readFile: (p: string) =>
    Bun.file(p)
      .arrayBuffer()
      .then((b: ArrayBuffer) => new Uint8Array(b)),
  writeTextFile: (p: string, d: string) => Bun.write(p, d).then(() => {}),
  writeFile: (p: string, d: Uint8Array) => Bun.write(p, d).then(() => {}),
  stat: async (p: string) => {
    const s = await stat(p);
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      size: s.size,
      mtime: s.mtime,
    };
  },
  readDir: async function* (p: string) {
    const entries = await readdir(p, { withFileTypes: true });
    for (const e of entries) {
      yield {
        name: e.name,
        isFile: e.isFile(),
        isDirectory: e.isDirectory(),
        isSymlink: e.isSymbolicLink(),
      };
    }
  },
  mkdir: (p: string, opts?: { recursive?: boolean }) => mkdir(p, opts),
  remove: (p: string, opts?: { recursive?: boolean }) => rm(p, opts),

  // Sync filesystem
  readTextFileSync: (p: string) => {
    const buf = Bun.file(p);
    // Bun.file is lazy, use Node sync for actual sync reads
    const fs = require('fs');
    return fs.readFileSync(p, 'utf-8');
  },
  writeFileSync: (p: string, d: string | Uint8Array) => {
    const fs = require('fs');
    if (typeof d === 'string') {
      fs.writeFileSync(p, d, 'utf-8');
    } else {
      fs.writeFileSync(p, d);
    }
  },
  statSync: (p: string) => {
    const fs = require('fs');
    const s = fs.statSync(p);
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      isSymlink: s.isSymbolicLink(),
      size: s.size,
      mtime: s.mtime,
      atime: s.atime,
      birthtime: s.birthtime,
      mode: s.mode,
    };
  },
  readDirSync: function* (p: string) {
    const fs = require('fs');
    const entries = fs.readdirSync(p, { withFileTypes: true });
    for (const e of entries) {
      yield {
        name: e.name,
        isFile: e.isFile(),
        isDirectory: e.isDirectory(),
        isSymlink: e.isSymbolicLink(),
      };
    }
  },
  removeSync: (p: string, opts?: { recursive?: boolean }) => {
    const fs = require('fs');
    if (opts?.recursive) {
      fs.rmSync(p, { recursive: true });
    } else {
      fs.rmSync(p);
    }
  },
  mkdirSync: (p: string, opts?: { recursive?: boolean }) => {
    const fs = require('fs');
    fs.mkdirSync(p, opts);
  },

  // Process / Runtime
  exit: (c?: number) => process.exit(c),
  cwd: () => process.cwd(),
  args: process.argv.slice(2),
  pid: process.pid,
  build: {
    os:
      process.platform === "linux"
        ? "linux"
        : process.platform === "darwin"
          ? "darwin"
          : "windows",
  },
  networkInterfaces: () => [],
  hostname: () => process.env.HOSTNAME || "edge-runtime",
  version: { deno: "1.40.0-compat-bun", v8: "n/a", typescript: "5.4" },

  // Network (placeholders — functions should not use these)
  listen: () => {
    throw new Error("Deno.listen() not supported, use Elysia");
  },
  connect: () => {
    throw new Error("Deno.connect() not supported, use fetch/Bun.connect");
  },
  Command: class Command {
    private cmd: string;
    private args: string[];
    private opts: any;
    
    constructor(cmd: string, opts?: { args?: string[]; cwd?: string; env?: Record<string, string>; stdin?: 'inherit' | 'piped' | 'null'; stdout?: 'inherit' | 'piped' | 'null'; stderr?: 'inherit' | 'piped' | 'null' }) {
      this.cmd = cmd;
      this.args = opts?.args || [];
      this.opts = opts || {};
    }
    
    async output() {
      const proc = Bun.spawn([this.cmd, ...this.args], {
        cwd: this.opts.cwd,
        env: this.opts.env ? { ...process.env, ...this.opts.env } : process.env,
        stdout: this.opts.stdout === 'piped' ? 'pipe' : (this.opts.stdout === 'null' ? 'ignore' : 'inherit'),
        stderr: this.opts.stderr === 'piped' ? 'pipe' : (this.opts.stderr === 'null' ? 'ignore' : 'inherit'),
      });
      const exitCode = await proc.exited;
      const stdout = proc.stdout ? await new Response(proc.stdout).arrayBuffer().then(b => new Uint8Array(b)) : new Uint8Array(0);
      const stderr = proc.stderr ? await new Response(proc.stderr).arrayBuffer().then(b => new Uint8Array(b)) : new Uint8Array(0);
      return { stdout, stderr, code: exitCode, success: exitCode === 0 };
    }
    
    outputSync() {
      const proc = Bun.spawnSync([this.cmd, ...this.args], {
        cwd: this.opts.cwd,
        env: this.opts.env ? { ...process.env, ...this.opts.env } : process.env,
        stdout: this.opts.stdout === 'piped' ? 'pipe' : (this.opts.stdout === 'null' ? 'ignore' : 'inherit'),
        stderr: this.opts.stderr === 'piped' ? 'pipe' : (this.opts.stderr === 'null' ? 'ignore' : 'inherit'),
      });
      return {
        stdout: new Uint8Array(proc.stdout?.buffer || new ArrayBuffer(0)),
        stderr: new Uint8Array(proc.stderr?.buffer || new ArrayBuffer(0)),
        code: proc.exitCode ?? 1,
        success: proc.exitCode === 0,
      };
    }
    
    spawn() {
      return Bun.spawn([this.cmd, ...this.args], {
        cwd: this.opts.cwd,
        env: this.opts.env ? { ...process.env, ...this.opts.env } : process.env,
        stdin: this.opts.stdin === 'piped' ? 'pipe' : (this.opts.stdin === 'null' ? 'ignore' : 'inherit'),
        stdout: this.opts.stdout === 'piped' ? 'pipe' : (this.opts.stdout === 'null' ? 'ignore' : 'inherit'),
        stderr: this.opts.stderr === 'piped' ? 'pipe' : (this.opts.stderr === 'null' ? 'ignore' : 'inherit'),
      });
    }
  },
  serve: (handlerOrOpts: any, maybeHandler?: any) => {
    if (typeof handlerOrOpts === "function") {
      // Form: Deno.serve(handler)
      capturedServeHandler = handlerOrOpts;
    } else if (typeof maybeHandler === "function") {
      // Form: Deno.serve(options, handler)
      capturedServeHandler = maybeHandler;
    } else if (handlerOrOpts && typeof handlerOrOpts === "object") {
      // Form: Deno.serve({ handler: fn }) or Deno.serve({ fetch: fn })
      capturedServeHandler =
        handlerOrOpts.handler || handlerOrOpts.fetch || null;
    }
    const mockServer = {
      finished: Promise.resolve(),
      shutdown: async () => {},
      ref: () => mockServer,
      unref: () => mockServer,
      addr: { transport: "tcp" as const, hostname: "0.0.0.0", port: 0 },
    };
    return mockServer;
  },

  // Utility
  inspect: (v: unknown) => JSON.stringify(v, null, 2),

  // WebSocket upgrade support
  upgradeWebSocket: (req: Request, opts?: { protocol?: string | string[] }) => {
    // In Bun, WebSocket upgrades are handled by Bun.serve()'s websocket option.
    // For edge functions that call Deno.upgradeWebSocket(), we create a 
    // WebSocket pair using Bun's native WebSocket.
    // NOTE: This only works when the edge runtime server is configured with
    // Bun.serve({ websocket: { ... } }). See server.ts.
    
    const protocols = opts?.protocol 
      ? (Array.isArray(opts.protocol) ? opts.protocol : [opts.protocol])
      : [];
    
    // Create a WebSocket pair using MessageChannel-like approach
    // Bun provides WebSocket natively, so we create a client socket
    // and return the response/socket pair as Deno would
    
    // For the response, we need to return a 101 Switching Protocols response
    // The actual upgrade is handled by the Bun.serve websocket handler
    
    const headers = new Headers();
    headers.set('Upgrade', 'websocket');
    headers.set('Connection', 'Upgrade');
    if (protocols.length > 0) {
      headers.set('Sec-WebSocket-Protocol', protocols.join(', '));
    }
    
    // Create a mock WebSocket that bridges to the real one
    // The server.ts Bun.serve handler will intercept the upgrade
    const ws = new WebSocket('ws://edge-runtime-internal/upgrade');
    
    // Return the standard Deno.upgradeWebSocket result shape
    return {
      response: new Response(null, { status: 101, headers }),
      socket: ws,
    };
  },
};

// ── Additional Deno namespace stubs ────────────────────────────────────
// These are used by popular Deno libraries but have no direct Bun equivalent.
// Stubs prevent ReferenceErrors while providing meaningful error messages.

// Deno.errors — standard error classes
(globalThis as any).Deno.errors = {
  NotFound: class NotFound extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "NotFound";
    }
  },
  PermissionDenied: class PermissionDenied extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "PermissionDenied";
    }
  },
  ConnectionRefused: class ConnectionRefused extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "ConnectionRefused";
    }
  },
  ConnectionReset: class ConnectionReset extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "ConnectionReset";
    }
  },
  ConnectionAborted: class ConnectionAborted extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "ConnectionAborted";
    }
  },
  NotConnected: class NotConnected extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "NotConnected";
    }
  },
  AddrInUse: class AddrInUse extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "AddrInUse";
    }
  },
  AddrNotAvailable: class AddrNotAvailable extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "AddrNotAvailable";
    }
  },
  BrokenPipe: class BrokenPipe extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "BrokenPipe";
    }
  },
  AlreadyExists: class AlreadyExists extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "AlreadyExists";
    }
  },
  InvalidData: class InvalidData extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "InvalidData";
    }
  },
  TimedOut: class TimedOut extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "TimedOut";
    }
  },
  Interrupted: class Interrupted extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "Interrupted";
    }
  },
  WriteZero: class WriteZero extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "WriteZero";
    }
  },
  UnexpectedEof: class UnexpectedEof extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "UnexpectedEof";
    }
  },
  Http: class Http extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "Http";
    }
  },
  Busy: class Busy extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "Busy";
    }
  },
  NotSupported: class NotSupported extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "NotSupported";
    }
  },
};

// Deno.permissions — stub (Bun doesn't have a permissions model)
(globalThis as any).Deno.permissions = {
  query: async (_desc: unknown) => ({ state: "granted" as const }),
  request: async (_desc: unknown) => ({ state: "granted" as const }),
  revoke: async (_desc: unknown) => ({ state: "denied" as const }),
};

// Deno.openKv — stub (Bun doesn't have built-in KV; use a simple in-memory Map)
// This is a minimal implementation for compatibility. For production KV, use an external store.
(globalThis as any).Deno.openKv = async (_path?: string) => {
  const store = new Map<string, { value: unknown; versionstamp: string }>();
  let versionCounter = 0;

  return {
    get: async (key: unknown[]) => {
      const k = JSON.stringify(key);
      const entry = store.get(k);
      return entry
        ? { key, value: entry.value, versionstamp: entry.versionstamp }
        : { key, value: null, versionstamp: null };
    },
    set: async (key: unknown[], value: unknown) => {
      const k = JSON.stringify(key);
      const versionstamp = String(++versionCounter).padStart(20, "0");
      store.set(k, { value, versionstamp });
      return { ok: true, versionstamp };
    },
    delete: async (key: unknown[]) => {
      store.delete(JSON.stringify(key));
    },
    list: async function* ({ prefix }: { prefix: unknown[] }) {
      const prefixStr = JSON.stringify(prefix).slice(0, -1); // strip closing ]
      for (const [k, v] of store) {
        if (k.startsWith(prefixStr)) {
          yield {
            key: JSON.parse(k),
            value: v.value,
            versionstamp: v.versionstamp,
          };
        }
      }
    },
    getMany: async (keys: unknown[][]) => {
      return keys.map((key) => {
        const k = JSON.stringify(key);
        const entry = store.get(k);
        return entry
          ? { key, value: entry.value, versionstamp: entry.versionstamp }
          : { key, value: null, versionstamp: null };
      });
    },
    atomic: () => {
      const ops: Array<() => void> = [];
      const tx = {
        set: (key: unknown[], value: unknown) => {
          ops.push(() => {
            store.set(JSON.stringify(key), {
              value,
              versionstamp: String(++versionCounter).padStart(20, "0"),
            });
          });
          return tx;
        },
        delete: (key: unknown[]) => {
          ops.push(() => store.delete(JSON.stringify(key)));
          return tx;
        },
        check: (..._checks: unknown[]) => tx,
        commit: async () => {
          for (const op of ops) op();
          return {
            ok: true,
            versionstamp: String(versionCounter).padStart(20, "0"),
          };
        },
      };
      return tx;
    },
    close: () => {},
    [Symbol.asyncDispose]: async () => {},
  };
};



console.log("[Deno Compat] Loaded Deno API compatibility shim");
