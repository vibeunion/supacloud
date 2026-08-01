import { expect, test } from "bun:test";
import { syncBuiltinESMExports } from "node:module";
import {
  disableSubprocessApis,
  FILESYSTEM_DISABLED_MESSAGE,
  NATIVE_LOADER_DISABLED_MESSAGE,
  setProjectRoot,
} from "./deno-compat";

test("Deno.Command fails closed for every subprocess command", () => {
  const DenoCompat = (globalThis as any).Deno;

  for (const command of ["dash", "awk", "sed", "echo"]) {
    expect(() => new DenoCompat.Command(command, { args: ["--version"] }))
      .toThrow("Subprocess execution is disabled in the multi-tenant Edge Runtime.");
  }
});

test("the worker subprocess guard disables and restores process creation APIs", async () => {
  const bun = globalThis.Bun as unknown as Record<string, unknown>;
  const childProcess = require("node:child_process") as Record<string, unknown>;
  const fs = require("node:fs") as Record<string, unknown>;
  const fsPromises = require("node:fs/promises") as Record<string, unknown>;
  const ffiModule = require("bun:ffi") as Record<string, unknown>;
  const moduleApi = require("node:module") as Record<string, unknown>;
  const workerThreads = require("node:worker_threads") as Record<string, unknown>;
  const cluster = require("node:cluster") as Record<string, unknown>;
  const originalShell = bun.$;
  const originalSpawn = bun.spawn;
  const originalSpawnSync = bun.spawnSync;
  const originalBunFile = bun.file;
  const originalBunWrite = bun.write;
  const originalBunDlopen = bun.dlopen;
  const originalFfi = { ...(bun.FFI as Record<string, unknown>) };
  const originalFfiModule = { ...ffiModule };
  const originalNativeFfi = { ...(ffiModule.native as Record<string, unknown>) };
  const originalWorker = (globalThis as Record<string, unknown>).Worker;
  const originalWorkerThread = workerThreads.Worker;
  const originalClusterFork = cluster.fork;
  const originalFs = Object.fromEntries(
    Object.entries(fs).filter(([, value]) => typeof value === "function"),
  );
  const originalFsPromises = Object.fromEntries(
    Object.entries(fsPromises).filter(([, value]) => typeof value === "function"),
  );
  const originalProcessLoaders = Object.fromEntries(
    ["dlopen", "binding", "_linkedBinding", "getBuiltinModule"]
      .map((name) => [name, (process as unknown as Record<string, unknown>)[name]]),
  );
  const originalModuleCreateRequire = moduleApi.createRequire;
  const originalModuleLoad = moduleApi._load;
  const modulePrototype = (moduleApi.Module as { prototype?: Record<string, unknown> } | undefined)?.prototype
    || (moduleApi as { prototype?: Record<string, unknown> }).prototype;
  const originalModuleRequire = modulePrototype?.require;
  const originalChildProcess = Object.fromEntries(
    ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"]
      .map((name) => [name, childProcess[name]]),
  );

  try {
    disableSubprocessApis();
    setProjectRoot(import.meta.dir);
    expect(() => Bun.$`true`)
      .toThrow("Subprocess execution is disabled in the multi-tenant Edge Runtime.");
    expect(() => Bun.spawn(["true"]))
      .toThrow("Subprocess execution is disabled in the multi-tenant Edge Runtime.");
    expect(() => Bun.spawnSync(["true"]))
      .toThrow("Subprocess execution is disabled in the multi-tenant Edge Runtime.");
    expect(() => Bun.file("/etc/hosts"))
      .toThrow("outside the project directory");
    expect(() => fs.readFileSync("/etc/hosts", "utf8"))
      .toThrow(FILESYSTEM_DISABLED_MESSAGE);
    expect(() => (process as unknown as Record<string, () => unknown>).binding())
      .toThrow(NATIVE_LOADER_DISABLED_MESSAGE);
    expect(() => {
      const tenantRequire = (moduleApi.createRequire as (url: string) => (id: string) => unknown)(import.meta.url);
      tenantRequire("node:fs");
    })
      .toThrow(NATIVE_LOADER_DISABLED_MESSAGE);
    expect(() => new (globalThis.Worker as unknown as new (url: string) => Worker)("data:text/javascript,"))
      .toThrow("Subprocess execution is disabled in the multi-tenant Edge Runtime.");
    expect(() => new (workerThreads.Worker as new (code: string) => unknown)("", { eval: true }))
      .toThrow("Subprocess execution is disabled in the multi-tenant Edge Runtime.");
    expect(() => cluster.fork())
      .toThrow("Subprocess execution is disabled in the multi-tenant Edge Runtime.");

    const ffi = await import("bun:ffi");
    expect(() => ffi.dlopen("libc.so.6", {}))
      .toThrow("Subprocess execution is disabled in the multi-tenant Edge Runtime.");
    expect(() => ffi.cc({ source: "ignored.c", symbols: {} }))
      .toThrow("Subprocess execution is disabled in the multi-tenant Edge Runtime.");
    expect(() => ffi.CFunction({ ptr: 1, args: [], returns: ffi.FFIType.i32 }))
      .toThrow("Subprocess execution is disabled in the multi-tenant Edge Runtime.");
  } finally {
    setProjectRoot(null);
    bun.$ = originalShell;
    bun.spawn = originalSpawn;
    bun.spawnSync = originalSpawnSync;
    bun.file = originalBunFile;
    bun.write = originalBunWrite;
    if (originalBunDlopen !== undefined) bun.dlopen = originalBunDlopen;
    Object.assign(bun.FFI as Record<string, unknown>, originalFfi);
    Object.assign(ffiModule, originalFfiModule);
    Object.assign(ffiModule.native as Record<string, unknown>, originalNativeFfi);
    (globalThis as Record<string, unknown>).Worker = originalWorker;
    workerThreads.Worker = originalWorkerThread;
    cluster.fork = originalClusterFork;
    Object.assign(childProcess, originalChildProcess);
    Object.assign(fs, originalFs);
    Object.assign(fsPromises, originalFsPromises);
    Object.assign(process as unknown as Record<string, unknown>, originalProcessLoaders);
    moduleApi.createRequire = originalModuleCreateRequire;
    moduleApi._load = originalModuleLoad;
    if (modulePrototype && originalModuleRequire) modulePrototype.require = originalModuleRequire;
    syncBuiltinESMExports();
  }
});
