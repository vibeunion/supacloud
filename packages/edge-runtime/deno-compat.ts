import { stat, readdir, mkdir, rm } from "fs/promises";

let capturedServeHandler: Function | null = null;
export function getCapturedServeHandler() { return capturedServeHandler; }
export function clearCapturedServeHandler() { capturedServeHandler = null; }

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
  writeTextFile: (p: string, d: string) =>
    Bun.write(p, d).then(() => {}),
  writeFile: (p: string, d: Uint8Array) =>
    Bun.write(p, d).then(() => {}),
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
  version: { deno: "compat-bun", v8: "n/a", typescript: "5.x" },

  // Network (placeholders — functions should not use these)
  listen: () => {
    throw new Error("Deno.listen() not supported, use Elysia");
  },
  connect: () => {
    throw new Error("Deno.connect() not supported, use fetch/Bun.connect");
  },
  serve: (handlerOrOpts: any, maybeHandler?: any) => {
    capturedServeHandler = typeof handlerOrOpts === "function" ? handlerOrOpts : maybeHandler;
    return { finished: new Promise(() => {}), shutdown: async () => {}, ref: () => {}, unref: () => {} };
  },

  // Utility
  inspect: (v: unknown) => JSON.stringify(v, null, 2),
};

console.log("[Deno Compat] Loaded Deno API compatibility shim");
