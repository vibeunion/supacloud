import { AsyncLocalStorage } from "node:async_hooks";
import path from "path";
import { builtinModules, syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

export type CapturedServeHandler = (
  request: Request,
) => Response | Promise<Response>;

let capturedServeHandler: CapturedServeHandler | null = null;
export const SUBPROCESS_DISABLED_MESSAGE =
  "Subprocess execution is disabled in the multi-tenant Edge Runtime.";
export const FILESYSTEM_DISABLED_MESSAGE =
  "Direct file system module access is disabled in the multi-tenant Edge Runtime.";
export const NATIVE_LOADER_DISABLED_MESSAGE =
  "Native and builtin module loaders are disabled in the multi-tenant Edge Runtime.";
export const DYNAMIC_CODE_DISABLED_MESSAGE =
  "Dynamic code generation is disabled in the multi-tenant Edge Runtime.";
export const HOST_RUNTIME_DISABLED_MESSAGE =
  "Host runtime capabilities are disabled in the multi-tenant Edge Runtime.";

const KNOWN_RUNTIME_BUILTINS = new Set(
  builtinModules.map((specifier) => specifier.replace(/^node:/, "")),
);
// Bun exposes host-specific and future builtins through builtinModules, so tenant
// compatibility must remain an explicit allowlist and fail closed on upgrades.
const TENANT_NODE_BUILTINS = new Set([
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "constants",
  "crypto",
  "dns",
  "dns/promises",
  "events",
  "http",
  "https",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "punycode",
  "querystring",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "timers",
  "timers/promises",
  "tls",
  "tty",
  "url",
  "util",
  "util/types",
  "zlib",
]);
export function tenantBuiltinSpecifier(request: unknown): string | null {
  if (typeof request !== "string") return null;
  // The bare Bun namespace is patched before tenant modules load, so preserving
  // this entry keeps guarded file/spawn APIs without exposing bun:* host modules.
  if (request === "bun") return request;
  const bareSpecifier = request.replace(/^node:/, "");
  if (!TENANT_NODE_BUILTINS.has(bareSpecifier)) return null;
  return `node:${bareSpecifier}`;
}

export function isKnownRuntimeBuiltinSpecifier(request: string): boolean {
  return request === "bun"
    || KNOWN_RUNTIME_BUILTINS.has(request.replace(/^node:/, ""));
}

const nodeFs = require("node:fs") as typeof import("node:fs");
const nodeFsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
const runtimeProcessBinding = (process as unknown as Record<string, unknown>).binding as
  ((...args: unknown[]) => unknown) | undefined;
const tenantUvBinding = createTenantUvBinding(runtimeProcessBinding);
const runtimeFs = {
  lstatSync: nodeFs.lstatSync.bind(nodeFs),
  realpathSync: nodeFs.realpathSync.bind(nodeFs),
  readFileSync: nodeFs.readFileSync.bind(nodeFs),
  writeFileSync: nodeFs.writeFileSync.bind(nodeFs),
  statSync: nodeFs.statSync.bind(nodeFs),
  readdirSync: nodeFs.readdirSync.bind(nodeFs),
  rmSync: nodeFs.rmSync.bind(nodeFs),
  mkdirSync: nodeFs.mkdirSync.bind(nodeFs),
  stat: nodeFsPromises.stat.bind(nodeFsPromises),
  readdir: nodeFsPromises.readdir.bind(nodeFsPromises),
  mkdir: nodeFsPromises.mkdir.bind(nodeFsPromises),
  rm: nodeFsPromises.rm.bind(nodeFsPromises),
};
const runtimeBunFile = Bun.file.bind(Bun);
const runtimeBunWrite = Bun.write.bind(Bun);
const DISABLED_BUN_HOST_CAPABILITIES = [
  "Archive",
  "FileSystemRouter",
  "Glob",
  "Terminal",
  "cron",
  "generateHeapSnapshot",
  "listen",
  "openInEditor",
  "serve",
  "udpSocket",
];

let projectRootControlInitialized = false;

export function initializeProjectRootControl(): (root: string | null) => void {
  if (projectRootControlInitialized) {
    throw new Error("Project root control is already initialized.");
  }
  projectRootControlInitialized = true;
  return setProjectRoot;
}

export function getCapturedServeHandler() {
  return capturedServeHandler;
}
export function clearCapturedServeHandler() {
  capturedServeHandler = null;
}

export function disableSubprocessApis(): void {
  const subprocessDisabled = () => {
    throw new Error(SUBPROCESS_DISABLED_MESSAGE);
  };
  const nativeLoaderDisabled = () => {
    throw new Error(NATIVE_LOADER_DISABLED_MESSAGE);
  };
  const DisabledWorker = class {
    constructor() {
      subprocessDisabled();
    }
  };
  if (globalThis.Bun) {
    const bun = globalThis.Bun as unknown as Record<string, unknown>;
    bun.$ = subprocessDisabled;
    bun.spawn = subprocessDisabled;
    bun.spawnSync = subprocessDisabled;
    bun.build = dynamicCodeDisabled;
    if (typeof bun.mmap === "function") bun.mmap = filesystemDisabled;
    if (typeof bun.dlopen === "function") bun.dlopen = nativeLoaderDisabled;
    disableBunHostCapabilities(bun);
    bun.file = (...args: unknown[]) => {
      assertPathInProject(args[0]);
      return (runtimeBunFile as unknown as (...fileArgs: unknown[]) => unknown)(...args);
    };
    bun.write = (...args: unknown[]) => {
      assertPathInProject(args[0]);
      return (runtimeBunWrite as unknown as (...writeArgs: unknown[]) => unknown)(...args);
    };

    // bun:ffi named exports bind to underlying Bun.FFI entries upon first import.
    // Must disable before loading tenant modules, otherwise Bun.spawn can be bypassed to call libc system() directly.
    const ffi = bun.FFI as Record<string, unknown> | undefined;
    if (ffi) {
      for (const name of Object.getOwnPropertyNames(ffi)) {
        if (typeof ffi[name] === "function") ffi[name] = nativeLoaderDisabled;
      }
      const ffiRead = ffi.read as Record<string, unknown> | undefined;
      if (ffiRead) {
        for (const name of Object.getOwnPropertyNames(ffiRead)) {
          if (typeof ffiRead[name] === "function") ffiRead[name] = nativeLoaderDisabled;
        }
      }
    }
  }

  const ffiModule = require("bun:ffi") as Record<string, unknown>;
  for (const name of ["CFunction", "JSCallback", "cc", "dlopen", "linkSymbols"]) {
    ffiModule[name] = subprocessDisabled;
  }
  const nativeFfi = ffiModule.native as Record<string, unknown> | undefined;
  if (nativeFfi) {
    nativeFfi.dlopen = subprocessDisabled;
    nativeFfi.callback = subprocessDisabled;
  }

  // New Workers have separate global objects and will not inherit guards installed in this worker.
  // If tenants are allowed to create Workers, they could invoke unpatched Bun.spawn in child workers.
  (globalThis as Record<string, unknown>).Worker = DisabledWorker;
  const workerThreads = require("node:worker_threads") as Record<string, unknown>;
  workerThreads.Worker = DisabledWorker;

  const childProcess = require("node:child_process") as Record<string, unknown>;
  for (const name of ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"]) {
    childProcess[name] = subprocessDisabled;
  }
  const cluster = require("node:cluster") as Record<string, unknown>;
  cluster.fork = subprocessDisabled;

  guardFunctionExports(
    nodeFs as unknown as Record<string, unknown>,
  );
  guardFunctionExports(
    nodeFsPromises as unknown as Record<string, unknown>,
  );

  const processApi = process as unknown as Record<string, unknown>;
  for (const name of ["dlopen", "_linkedBinding", "getBuiltinModule"]) {
    if (typeof processApi[name] === "function") processApi[name] = nativeLoaderDisabled;
  }
  // node:net and node:tls initial load depends on uv error mapping; other native bindings remain disabled.
  processApi.binding = function (request: unknown, ...args: unknown[]) {
    if (request !== "uv" || args.length > 0 || !tenantUvBinding) return nativeLoaderDisabled();
    return tenantUvBinding;
  };

  const moduleApi = require("node:module") as Record<string, unknown>;
  moduleApi.createRequire = nativeLoaderDisabled;
  const originalModuleLoad = moduleApi._load as ((...args: unknown[]) => unknown) | undefined;
  if (originalModuleLoad) {
    moduleApi._load = function (this: unknown, request: unknown, ...args: unknown[]) {
      const builtinSpecifier = tenantBuiltinSpecifier(request);
      if (!builtinSpecifier) return nativeLoaderDisabled();
      return Reflect.apply(originalModuleLoad, this, [builtinSpecifier, ...args]);
    };
  }
  const modulePrototype = (moduleApi.Module as { prototype?: Record<string, unknown> } | undefined)?.prototype
    || (moduleApi as { prototype?: Record<string, unknown> }).prototype;
  const originalModuleRequire = modulePrototype?.require as ((...args: unknown[]) => unknown) | undefined;
  if (modulePrototype && originalModuleRequire) {
    modulePrototype.require = function (this: unknown, request: unknown, ...args: unknown[]) {
      const builtinSpecifier = tenantBuiltinSpecifier(request);
      if (!builtinSpecifier) return nativeLoaderDisabled();
      return Reflect.apply(originalModuleRequire, this, [builtinSpecifier, ...args]);
    };
  }
  syncBuiltinESMExports();
}

function createTenantUvBinding(
  processBinding: ((...args: unknown[]) => unknown) | undefined,
): Readonly<Record<string, unknown>> | null {
  if (!processBinding) return null;
  const rawUvBinding = Reflect.apply(processBinding, process, ["uv"]) as Record<string, unknown>;
  const safeEntries: Array<[string, unknown]> = [];
  for (const [name, value] of Object.entries(rawUvBinding)) {
    if (name.startsWith("UV_") && typeof value === "number") safeEntries.push([name, value]);
  }
  for (const name of ["errname", "getErrorMap"] as const) {
    const wrapped = createTenantUvFunction(name, rawUvBinding);
    if (wrapped) safeEntries.push([name, wrapped]);
  }
  return Object.freeze(Object.fromEntries(safeEntries));
}

function createTenantUvFunction(
  name: "errname" | "getErrorMap",
  rawUvBinding: Record<string, unknown>,
): ((...args: unknown[]) => unknown) | null {
  const rawFunction = rawUvBinding[name];
  if (typeof rawFunction !== "function") return null;
  const wrapped = (...args: unknown[]) => {
    const rawResult = Reflect.apply(rawFunction, rawUvBinding, args);
    if (name !== "getErrorMap" || !(rawResult instanceof Map)) return rawResult;
    const copiedEntries: Array<[unknown, unknown]> = [];
    for (const [code, details] of rawResult) {
      copiedEntries.push([
        code,
        Array.isArray(details) ? Object.freeze([...details]) : details,
      ]);
    }
    return new Map(copiedEntries);
  };
  return Object.freeze(wrapped);
}

function disableBunHostCapabilities(bun: Record<string, unknown>): void {
  for (const name of DISABLED_BUN_HOST_CAPABILITIES) {
    if (Object.getOwnPropertyDescriptor(bun, name)?.writable) {
      bun[name] = hostRuntimeDisabled;
    }
  }
}

export function guardDynamicCodeApis(validateSource: (source: string) => void): void {
  const constructors: Function[] = [
    Function,
    Object.getPrototypeOf(async function () {}).constructor,
    Object.getPrototypeOf(function* () {}).constructor,
    Object.getPrototypeOf(async function* () {}).constructor,
  ];

  Object.defineProperty(globalThis, "eval", {
    configurable: false,
    value: dynamicCodeDisabled,
    writable: false,
  });
  for (const originalConstructor of constructors) {
    installGuardedCodeConstructor(originalConstructor, validateSource);
  }
}

function installGuardedCodeConstructor(
  originalConstructor: Function,
  validateSource: (source: string) => void,
): void {
  const guardedConstructor = function (this: unknown, ...args: unknown[]) {
    for (const argument of args) validateSource(String(argument));
    return Reflect.apply(originalConstructor, this, args);
  };
  Object.setPrototypeOf(guardedConstructor, Object.getPrototypeOf(originalConstructor));
  Object.defineProperty(guardedConstructor, "prototype", { value: originalConstructor.prototype });
  Object.defineProperty(originalConstructor.prototype, "constructor", {
    configurable: false,
    value: guardedConstructor,
    writable: false,
  });
  if (originalConstructor === Function) {
    Object.defineProperty(globalThis, "Function", {
      configurable: false,
      value: guardedConstructor,
      writable: false,
    });
  }
}

function dynamicCodeDisabled(): never {
  throw new Error(DYNAMIC_CODE_DISABLED_MESSAGE);
}

function filesystemDisabled(): never {
  throw new Error(FILESYSTEM_DISABLED_MESSAGE);
}

function hostRuntimeDisabled(): never {
  throw new Error(HOST_RUNTIME_DISABLED_MESSAGE);
}

function guardFunctionExports(
  target: Record<string, unknown>,
): void {
  for (const name of Object.getOwnPropertyNames(target)) {
    const original = target[name];
    if (typeof original !== "function") continue;
    if (FILESYSTEM_VALUE_CONSTRUCTORS.has(name)) continue;

    const guarded = function (this: unknown, ...args: unknown[]) {
      assertFilesystemOperation(name, args);
      if (new.target) return Reflect.construct(original, args, original);
      return Reflect.apply(original, this, args);
    };
    target[name] = guarded;
  }
}

function capturedHandler(candidate: unknown): CapturedServeHandler | null {
  return typeof candidate === "function"
    ? candidate as CapturedServeHandler
    : null;
}

type ProjectPathContext = {
  lexicalRoot: string;
  realRoot: string;
};

const runtimeDependencyContext: ProjectPathContext = (() => {
  const lexicalRoot = path.resolve(import.meta.dir, "node_modules");
  let realRoot = lexicalRoot;
  try {
    realRoot = runtimeFs.realpathSync(lexicalRoot);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  return {
    lexicalRoot,
    realRoot,
  };
})();

const FILESYSTEM_VALUE_CONSTRUCTORS = new Set([
  "Dir",
  "Dirent",
  "Stats",
  "_toUnixTimestamp",
]);

const READ_PATH_OPERATIONS = new Map<string, readonly number[]>([
  ["access", [0]],
  ["accessSync", [0]],
  ["createReadStream", [0]],
  ["exists", [0]],
  ["existsSync", [0]],
  ["glob", [0]],
  ["globSync", [0]],
  ["lstat", [0]],
  ["lstatSync", [0]],
  ["openAsBlob", [0]],
  ["opendir", [0]],
  ["opendirSync", [0]],
  ["readFile", [0]],
  ["readFileSync", [0]],
  ["readdir", [0]],
  ["readdirSync", [0]],
  ["readlink", [0]],
  ["readlinkSync", [0]],
  ["realpath", [0]],
  ["realpathSync", [0]],
  ["stat", [0]],
  ["statSync", [0]],
  ["statfs", [0]],
  ["statfsSync", [0]],
  ["unwatchFile", [0]],
  ["watch", [0]],
  ["watchFile", [0]],
  ["ReadStream", [0]],
  ["FileReadStream", [0]],
]);

const WRITE_PATH_OPERATIONS = new Map<string, readonly number[]>([
  ["appendFile", [0]],
  ["appendFileSync", [0]],
  ["chmod", [0]],
  ["chmodSync", [0]],
  ["chown", [0]],
  ["chownSync", [0]],
  ["copyFile", [0, 1]],
  ["copyFileSync", [0, 1]],
  ["cp", [0, 1]],
  ["cpSync", [0, 1]],
  ["createWriteStream", [0]],
  ["lchmod", [0]],
  ["lchmodSync", [0]],
  ["lchown", [0]],
  ["lchownSync", [0]],
  ["link", [0, 1]],
  ["linkSync", [0, 1]],
  ["lutimes", [0]],
  ["lutimesSync", [0]],
  ["mkdir", [0]],
  ["mkdirSync", [0]],
  ["mkdtemp", [0]],
  ["mkdtempSync", [0]],
  ["rename", [0, 1]],
  ["renameSync", [0, 1]],
  ["rm", [0]],
  ["rmSync", [0]],
  ["rmdir", [0]],
  ["rmdirSync", [0]],
  ["truncate", [0]],
  ["truncateSync", [0]],
  ["unlink", [0]],
  ["unlinkSync", [0]],
  ["utimes", [0]],
  ["utimesSync", [0]],
  ["writeFile", [0]],
  ["writeFileSync", [0]],
  ["WriteStream", [0]],
  ["FileWriteStream", [0]],
]);

const FILE_DESCRIPTOR_OPERATIONS = new Set([
  "close",
  "closeSync",
  "fchmod",
  "fchmodSync",
  "fchown",
  "fchownSync",
  "fdatasync",
  "fdatasyncSync",
  "fstat",
  "fstatSync",
  "fsync",
  "fsyncSync",
  "ftruncate",
  "ftruncateSync",
  "futimes",
  "futimesSync",
  "read",
  "readSync",
  "readv",
  "readvSync",
  "write",
  "writeSync",
  "writev",
  "writevSync",
]);

const projectPathContext = new AsyncLocalStorage<ProjectPathContext | null>();
let activeProjectPathContext: ProjectPathContext | null = null;
let injectedEnvRef: Record<string, string> = {};

function setProjectRoot(root: string | null) {
  if (!root) {
    activeProjectPathContext = null;
    projectPathContext.enterWith(null);
    return;
  }
  const lexicalRoot = path.resolve(root);
  activeProjectPathContext = {
    lexicalRoot,
    realRoot: runtimeFs.realpathSync(lexicalRoot),
  };
  projectPathContext.enterWith(activeProjectPathContext);
}

export function setInjectedEnv(env: Record<string, string>) {
  injectedEnvRef = env;
}

function isPathInside(candidate: string, base: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function filesystemPath(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof URL) {
    if (value.protocol !== "file:") {
      throw new Error(`Access denied: URL protocol "${value.protocol}" is not a local project file`);
    }
    return fileURLToPath(value);
  }
  if (value && typeof value === "object" && typeof (value as { name?: unknown }).name === "string") {
    return (value as { name: string }).name;
  }
  throw new Error("Access denied: file descriptors and unverifiable file targets are not supported");
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function currentProjectPathContext(): ProjectPathContext | null {
  return projectPathContext.getStore() || activeProjectPathContext;
}

function assertPathInContext(value: unknown, context: ProjectPathContext): void {
  const requestedPath = filesystemPath(value);
  const resolved = path.resolve(requestedPath);
  const base = isPathInside(resolved, context.lexicalRoot)
    ? context.lexicalRoot
    : isPathInside(resolved, context.realRoot)
      ? context.realRoot
      : null;
  if (!base) {
    throw new Error(`Access denied: path "${requestedPath}" is outside the allowed directory`);
  }

  const relative = path.relative(base, resolved);
  let prefix = base;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    prefix = path.join(prefix, segment);
    try {
      runtimeFs.lstatSync(prefix);
      const realPrefix = runtimeFs.realpathSync(prefix);
      if (!isPathInside(realPrefix, context.realRoot)) {
        throw new Error(`Access denied: path "${requestedPath}" escapes through a symbolic link`);
      }
    } catch (error) {
      if (isMissingPathError(error)) break;
      throw error;
    }
  }
}

function isPathAllowed(value: unknown, context: ProjectPathContext): boolean {
  try {
    assertPathInContext(value, context);
    return true;
  } catch {
    return false;
  }
}

function assertFilesystemReadPath(value: unknown, context: ProjectPathContext): void {
  if (isPathAllowed(value, context) || isPathAllowed(value, runtimeDependencyContext)) return;
  throw new Error(FILESYSTEM_DISABLED_MESSAGE);
}

export function assertRuntimeDependencyPath(value: unknown): void {
  try {
    assertPathInContext(value, runtimeDependencyContext);
  } catch {
    throw new Error("Access denied: module is outside the trusted runtime dependency directory");
  }
}

function isReadOnlyOpen(flags: unknown): boolean {
  return flags === undefined
    || flags === "r"
    || flags === "rs"
    || flags === "sr"
    || flags === nodeFs.constants.O_RDONLY;
}

function assertFilesystemOperation(name: string, args: unknown[]): void {
  const context = currentProjectPathContext();
  if (!context) return;

  if (name === "symlink" || name === "symlinkSync") {
    throw new Error(FILESYSTEM_DISABLED_MESSAGE);
  }
  if (name === "open" || name === "openSync") {
    if (isReadOnlyOpen(args[1])) assertFilesystemReadPath(args[0], context);
    else assertPathInProject(args[0]);
    return;
  }

  const readPathIndexes = READ_PATH_OPERATIONS.get(name);
  if (readPathIndexes) {
    for (const index of readPathIndexes) assertFilesystemReadPath(args[index], context);
    return;
  }

  const writePathIndexes = WRITE_PATH_OPERATIONS.get(name);
  if (writePathIndexes) {
    for (const index of writePathIndexes) assertPathInProject(args[index]);
    return;
  }

  if (FILE_DESCRIPTOR_OPERATIONS.has(name)) return;
  throw new Error(FILESYSTEM_DISABLED_MESSAGE);
}

export function assertPathInProject(value: unknown): void {
  const context = currentProjectPathContext();
  const requestedPath = filesystemPath(value);
  if (!context) {
    throw new Error(`Access denied: no active project for path "${requestedPath}"`);
  }

  try {
    assertPathInContext(requestedPath, context);
  } catch (error) {
    if (error instanceof Error && error.message.includes("symbolic link")) throw error;
    throw new Error(`Access denied: path "${requestedPath}" is outside the project directory`);
  }
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
    return runtimeBunFile(p).text();
  },
  readFile: (p: string) => {
    assertPathInProject(p);
    return runtimeBunFile(p)
      .arrayBuffer()
      .then((b: ArrayBuffer) => new Uint8Array(b));
  },
  writeTextFile: (p: string, d: string) => {
    assertPathInProject(p);
    return runtimeBunWrite(p, d).then(() => {});
  },
  writeFile: (p: string, d: Uint8Array) => {
    assertPathInProject(p);
    return runtimeBunWrite(p, d).then(() => {});
  },
  stat: async (p: string) => {
    assertPathInProject(p);
    const s = await runtimeFs.stat(p);
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      size: s.size,
      mtime: s.mtime,
    };
  },
  readDir: async function* (p: string) {
    assertPathInProject(p);
    const entries = await runtimeFs.readdir(p, { withFileTypes: true });
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
    return runtimeFs.mkdir(p, opts);
  },
  remove: (p: string, opts?: { recursive?: boolean }) => {
    assertPathInProject(p);
    return runtimeFs.rm(p, opts);
  },

  readTextFileSync: (p: string) => {
    assertPathInProject(p);
    return runtimeFs.readFileSync(p, "utf-8");
  },
  writeFileSync: (p: string, d: string | Uint8Array) => {
    assertPathInProject(p);
    if (typeof d === "string") {
      runtimeFs.writeFileSync(p, d, "utf-8");
    } else {
      runtimeFs.writeFileSync(p, d);
    }
  },
  statSync: (p: string) => {
    assertPathInProject(p);
    const s = runtimeFs.statSync(p);
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
    const entries = runtimeFs.readdirSync(p, { withFileTypes: true });
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
    if (opts?.recursive) {
      runtimeFs.rmSync(p, { recursive: true });
    } else {
      runtimeFs.rmSync(p);
    }
  },
  mkdirSync: (p: string, opts?: { recursive?: boolean }) => {
    assertPathInProject(p);
    runtimeFs.mkdirSync(p, opts);
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
    constructor(
      _cmd: string,
      _opts?: {
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        stdin?: "inherit" | "piped" | "null";
        stdout?: "inherit" | "piped" | "null";
        stderr?: "inherit" | "piped" | "null";
      },
    ) {
      throw new Error(
        SUBPROCESS_DISABLED_MESSAGE,
      );
    }
  },
  serve: (handlerOrOpts: unknown, maybeHandler?: unknown) => {
    const options = handlerOrOpts && typeof handlerOrOpts === "object"
      ? handlerOrOpts as Record<string, unknown>
      : {};
    capturedServeHandler = capturedHandler(handlerOrOpts)
      || capturedHandler(maybeHandler)
      || capturedHandler(options.handler)
      || capturedHandler(options.fetch);
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

(globalThis as any).Deno.openKv = async (_path?: string) => {
  throw new (globalThis as any).Deno.errors.NotSupported(
    "Deno.openKv is disabled; use the request-scoped SupaCloud.pgredis binding",
  );
};

export { envWriteLog };

console.log("[Deno Compat] Loaded Deno API compatibility shim");
