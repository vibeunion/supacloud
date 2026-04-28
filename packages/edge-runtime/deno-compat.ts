import path from "path";

let capturedServeHandler: Function | null = null;
export function getCapturedServeHandler() {
  return capturedServeHandler;
}
export function clearCapturedServeHandler() {
  capturedServeHandler = null;
}

let currentTenantRef: string | null = null;
let currentProjectRoot: string | null = null;
let injectedEnvRef: Record<string, string> = {};

export function setTenantRef(ref: string | null) {
  currentTenantRef = ref;
}

export function setProjectRoot(root: string | null) {
  currentProjectRoot = root;
}

export function setInjectedEnv(env: Record<string, string>) {
  injectedEnvRef = env;
}

function isPathInside(candidate: string, base: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertPathInProject(p: string): void {
  if (!currentProjectRoot) return;
  const resolved = path.resolve(p);
  if (!isPathInside(resolved, currentProjectRoot)) {
    throw new Error(`Access denied: path "${p}" is outside the project directory`);
  }
}

const BLOCKED_COMMANDS = new Set([
  "mkfs", "shutdown", "reboot", "init",
  "fdisk", "parted", "dd",
  "cat", "head", "tail", "less", "more",
  "curl", "wget", "nc", "ncat", "netcat",
  "ssh", "scp", "sftp", "telnet",
  "env", "printenv", "export",
  "ps", "top", "htop", "lsof", "ss", "netstat",
  "whoami", "id", "hostname", "uname",
  "crontab", "at", "batch",
  "passwd", "su", "sudo", "doas",
  "chmod", "chown", "chgrp",
  "kill", "killall", "pkill",
  "docker", "podman", "kubectl",
  "python", "python3", "perl", "ruby", "node", "bun", "bash", "sh", "zsh", "fish",
  "rm", "rmdir",
]);

function isCommandBlocked(cmd: string): boolean {
  const base = cmd.split("/").pop() || cmd;
  return BLOCKED_COMMANDS.has(base);
}

const envWriteLog: Set<string> = new Set();

(globalThis as Record<string, unknown>).Deno = {
  env: {
    get: (k: string) => injectedEnvRef[k],
    set: (k: string, v: string) => {
      envWriteLog.add(k);
      injectedEnvRef[k] = v;
      process.env[k] = v;
    },
    delete: (k: string) => {
      envWriteLog.add(k);
      delete injectedEnvRef[k];
      delete process.env[k];
    },
    has: (k: string) => k in injectedEnvRef,
    toObject: () => ({ ...injectedEnvRef }),
  },

  readTextFile: (p: string) => {
    assertPathInProject(p);
    return Bun.file(p).text();
  },
  readFile: (p: string) => {
    assertPathInProject(p);
    return Bun.file(p)
      .arrayBuffer()
      .then((b: ArrayBuffer) => new Uint8Array(b));
  },
  writeTextFile: (p: string, d: string) => {
    assertPathInProject(p);
    return Bun.write(p, d).then(() => {});
  },
  writeFile: (p: string, d: Uint8Array) => {
    assertPathInProject(p);
    return Bun.write(p, d).then(() => {});
  },
  stat: async (p: string) => {
    assertPathInProject(p);
    const { stat } = await import("fs/promises");
    const s = await stat(p);
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      size: s.size,
      mtime: s.mtime,
    };
  },
  readDir: async function* (p: string) {
    assertPathInProject(p);
    const { readdir } = await import("fs/promises");
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
  mkdir: (p: string, opts?: { recursive?: boolean }) => {
    assertPathInProject(p);
    const fs = require("fs/promises");
    return fs.mkdir(p, opts);
  },
  remove: (p: string, opts?: { recursive?: boolean }) => {
    assertPathInProject(p);
    const fs = require("fs/promises");
    return fs.rm(p, opts);
  },

  readTextFileSync: (p: string) => {
    assertPathInProject(p);
    const fs = require("fs");
    return fs.readFileSync(p, "utf-8");
  },
  writeFileSync: (p: string, d: string | Uint8Array) => {
    assertPathInProject(p);
    const fs = require("fs");
    if (typeof d === "string") {
      fs.writeFileSync(p, d, "utf-8");
    } else {
      fs.writeFileSync(p, d);
    }
  },
  statSync: (p: string) => {
    assertPathInProject(p);
    const fs = require("fs");
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
    assertPathInProject(p);
    const fs = require("fs");
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
    assertPathInProject(p);
    const fs = require("fs");
    if (opts?.recursive) {
      fs.rmSync(p, { recursive: true });
    } else {
      fs.rmSync(p);
    }
  },
  mkdirSync: (p: string, opts?: { recursive?: boolean }) => {
    assertPathInProject(p);
    const fs = require("fs");
    fs.mkdirSync(p, opts);
  },

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

    constructor(
      cmd: string,
      opts?: {
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        stdin?: "inherit" | "piped" | "null";
        stdout?: "inherit" | "piped" | "null";
        stderr?: "inherit" | "piped" | "null";
      },
    ) {
      if (isCommandBlocked(cmd)) {
        throw new Error(
          `Deno.Command("${cmd}") is blocked for security reasons.`,
        );
      }
      this.cmd = cmd;
      this.args = opts?.args || [];
      this.opts = opts || {};
    }

    async output() {
      const proc = Bun.spawn([this.cmd, ...this.args], {
        cwd: this.opts.cwd,
        env: this.opts.env
          ? { ...process.env, ...this.opts.env }
          : process.env,
        stdout:
          this.opts.stdout === "piped"
            ? "pipe"
            : this.opts.stdout === "null"
              ? "ignore"
              : "inherit",
        stderr:
          this.opts.stderr === "piped"
            ? "pipe"
            : this.opts.stderr === "null"
              ? "ignore"
              : "inherit",
      });
      const exitCode = await proc.exited;
      const stdout = proc.stdout
        ? await new Response(proc.stdout)
            .arrayBuffer()
            .then((b) => new Uint8Array(b))
        : new Uint8Array(0);
      const stderr = proc.stderr
        ? await new Response(proc.stderr)
            .arrayBuffer()
            .then((b) => new Uint8Array(b))
        : new Uint8Array(0);
      return { stdout, stderr, code: exitCode, success: exitCode === 0 };
    }

    outputSync() {
      const proc = Bun.spawnSync([this.cmd, ...this.args], {
        cwd: this.opts.cwd,
        env: this.opts.env
          ? { ...process.env, ...this.opts.env }
          : process.env,
        stdout:
          this.opts.stdout === "piped"
            ? "pipe"
            : this.opts.stdout === "null"
              ? "ignore"
              : "inherit",
        stderr:
          this.opts.stderr === "piped"
            ? "pipe"
            : this.opts.stderr === "null"
              ? "ignore"
              : "inherit",
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
        env: this.opts.env
          ? { ...process.env, ...this.opts.env }
          : process.env,
        stdin:
          this.opts.stdin === "piped"
            ? "pipe"
            : this.opts.stdin === "null"
              ? "ignore"
              : "inherit",
        stdout:
          this.opts.stdout === "piped"
            ? "pipe"
            : this.opts.stdout === "null"
              ? "ignore"
              : "inherit",
        stderr:
          this.opts.stderr === "piped"
            ? "pipe"
            : this.opts.stderr === "null"
              ? "ignore"
              : "inherit",
      });
    }
  },
  serve: (handlerOrOpts: any, maybeHandler?: any) => {
    if (typeof handlerOrOpts === "function") {
      capturedServeHandler = handlerOrOpts;
    } else if (typeof maybeHandler === "function") {
      capturedServeHandler = maybeHandler;
    } else if (handlerOrOpts && typeof handlerOrOpts === "object") {
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

  inspect: (v: unknown) => JSON.stringify(v, null, 2),

  upgradeWebSocket: (
    _req: Request,
    _opts?: { protocol?: string | string[] },
  ) => {
    throw new Error(
      "Deno.upgradeWebSocket() is not supported in Bun Edge Runtime. " +
        "Use the standard WebSocket API or return a Response with status 101 from your function handler.",
    );
  },
};

(globalThis as any).Deno.errors = {
  NotFound: class NotFound extends Error {
    constructor(msg?: string) { super(msg); this.name = "NotFound"; }
  },
  PermissionDenied: class PermissionDenied extends Error {
    constructor(msg?: string) { super(msg); this.name = "PermissionDenied"; }
  },
  ConnectionRefused: class ConnectionRefused extends Error {
    constructor(msg?: string) { super(msg); this.name = "ConnectionRefused"; }
  },
  ConnectionReset: class ConnectionReset extends Error {
    constructor(msg?: string) { super(msg); this.name = "ConnectionReset"; }
  },
  ConnectionAborted: class ConnectionAborted extends Error {
    constructor(msg?: string) { super(msg); this.name = "ConnectionAborted"; }
  },
  NotConnected: class NotConnected extends Error {
    constructor(msg?: string) { super(msg); this.name = "NotConnected"; }
  },
  AddrInUse: class AddrInUse extends Error {
    constructor(msg?: string) { super(msg); this.name = "AddrInUse"; }
  },
  AddrNotAvailable: class AddrNotAvailable extends Error {
    constructor(msg?: string) { super(msg); this.name = "AddrNotAvailable"; }
  },
  BrokenPipe: class BrokenPipe extends Error {
    constructor(msg?: string) { super(msg); this.name = "BrokenPipe"; }
  },
  AlreadyExists: class AlreadyExists extends Error {
    constructor(msg?: string) { super(msg); this.name = "AlreadyExists"; }
  },
  InvalidData: class InvalidData extends Error {
    constructor(msg?: string) { super(msg); this.name = "InvalidData"; }
  },
  TimedOut: class TimedOut extends Error {
    constructor(msg?: string) { super(msg); this.name = "TimedOut"; }
  },
  Interrupted: class Interrupted extends Error {
    constructor(msg?: string) { super(msg); this.name = "Interrupted"; }
  },
  WriteZero: class WriteZero extends Error {
    constructor(msg?: string) { super(msg); this.name = "WriteZero"; }
  },
  UnexpectedEof: class UnexpectedEof extends Error {
    constructor(msg?: string) { super(msg); this.name = "UnexpectedEof"; }
  },
  Http: class Http extends Error {
    constructor(msg?: string) { super(msg); this.name = "Http"; }
  },
  Busy: class Busy extends Error {
    constructor(msg?: string) { super(msg); this.name = "Busy"; }
  },
  NotSupported: class NotSupported extends Error {
    constructor(msg?: string) { super(msg); this.name = "NotSupported"; }
  },
};

(globalThis as any).Deno.permissions = {
  query: async (_desc: unknown) => ({ state: "granted" as const }),
  request: async (_desc: unknown) => ({ state: "granted" as const }),
  revoke: async (_desc: unknown) => ({ state: "denied" as const }),
};

const kvStores = new Map<string, Map<string, { value: unknown; versionstamp: string }>>();
let globalVersionCounter = 0;

(globalThis as any).Deno.openKv = async (_path?: string) => {
  const tenantPrefix = currentTenantRef || "__default";
  const storeKey = `__kv_${tenantPrefix}_${_path || "__default"}`;
  if (!kvStores.has(storeKey)) {
    kvStores.set(storeKey, new Map());
  }
  const store = kvStores.get(storeKey)!;

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
      const versionstamp = String(++globalVersionCounter).padStart(20, "0");
      store.set(k, { value, versionstamp });
      return { ok: true, versionstamp };
    },
    delete: async (key: unknown[]) => {
      store.delete(JSON.stringify(key));
    },
    list: async function* ({ prefix }: { prefix: unknown[] }) {
      const prefixStr = JSON.stringify(prefix).slice(0, -1);
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
              versionstamp: String(++globalVersionCounter).padStart(20, "0"),
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
            versionstamp: String(globalVersionCounter).padStart(20, "0"),
          };
        },
      };
      return tx;
    },
    close: () => {},
    [Symbol.asyncDispose]: async () => {},
  };
};

export { envWriteLog };

console.log("[Deno Compat] Loaded Deno API compatibility shim");
