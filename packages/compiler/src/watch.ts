import { existsSync, watch } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { createIncrementalCompiler } from "./incremental";
import type { WatchEvent, WatchHandle, WatchOptions } from "./types";

const DEFAULT_DEBOUNCE_MS = 100;

function isCompilerConfigurationPath(rootDir: string, changedPath: string): boolean {
  const relativePath = relative(rootDir, changedPath).split(sep).join("/");
  return [
    "supacloud.config.ts",
    "supacloud.config.mts",
    "supacloud.config.js",
    "supacloud.config.mjs",
    "tsconfig.json",
  ].includes(relativePath) || /^tsconfig\.[^/]+\.json$/.test(relativePath);
}

/** Watch a project and keep the last successful generated artifacts active on errors. */
export function watchProject(options: WatchOptions): WatchHandle {
  const rootDir = resolve(options.rootDir);
  const outDir = resolve(options.outDir);
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed: boolean = false;
  let compiling: boolean = false;
  let activeCompilation: Promise<void> = Promise.resolve();
  let pending: boolean = false;
  const pendingPaths = new Set<string>();
  let watcher: ReturnType<typeof watch> | undefined;
  let schemaWatcher: ReturnType<typeof watch> | undefined;
  const schemaPath = options.graphql ? resolve(rootDir, options.graphql.schema) : undefined;
  const incremental = createIncrementalCompiler();
  let initialEvent: WatchEvent | undefined;
  let resolveReady: (event: WatchEvent) => void = () => undefined;
  let rejectReady: (error: unknown) => void = () => undefined;

  const ready = new Promise<WatchEvent>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });

  void ready.catch(() => undefined);

  const emit = (event: WatchEvent): void => {
    options.onEvent?.(event);
    if (event.initial) initialEvent = event;
  };

  const stopWatching = (): void => {
    closed = true;
    if (timer) clearTimeout(timer);
    watcher?.close();
    schemaWatcher?.close();
  };

  const compile = (initial: boolean, changedPaths: string[] = []): Promise<void> => {
    if (closed && !initial) return Promise.resolve();
    if (compiling) {
      pending = true;
      for (const path of changedPaths) pendingPaths.add(path);
      return activeCompilation;
    }
    compiling = true;
    // Assign the promise before invoking callbacks: close() from compile-start must drain this run.
    activeCompilation = Promise.resolve().then(async () => {
      const startedAt = performance.now();
      try {
        options.onEvent?.({
          type: "compile-start", initial, durationMs: 0, diagnostics: [], written: [],
        });
        const result = await incremental.compile({ ...options, writeOnError: false }, changedPaths);
        const hasErrors = result.diagnostics.some((diagnostic) => diagnostic.severity === "error");
        emit({
          type: hasErrors ? "compile-error" : "compiled", initial,
          durationMs: Math.round(performance.now() - startedAt),
          diagnostics: result.diagnostics, written: result.written, stats: result.stats,
        });
      } catch (error) {
        if (initial) throw error;
        // A filesystem/compiler exception is a failed rebuild, not an unhandled background rejection.
        // Do not echo arbitrary exception text, which may include source or configuration secrets.
        emit({
          type: "compile-error", initial: false,
          durationMs: Math.round(performance.now() - startedAt),
          diagnostics: [{ code: "watch-compile", severity: "error",
            message: "Watch compilation failed; check project files and configuration before retrying." }],
          written: [],
        });
      } finally {
        compiling = false;
        if (pending && !closed) {
          pending = false;
          const paths = [...pendingPaths];
          pendingPaths.clear();
          startRecompile(paths);
        }
      }
    });
    return activeCompilation;
  };

  const startRecompile = (paths: string[]): void => {
    // The only remaining rejection is an observer throwing while receiving the failure event.
    // Stop safely rather than retaining live watchers with a broken observer.
    void compile(false, paths).catch(stopWatching);
  };

  const schedule = (changedPath?: string): void => {
    if (closed) return;
    if (changedPath) pendingPaths.add(changedPath);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const paths = [...pendingPaths];
      pendingPaths.clear();
      startRecompile(paths);
    }, debounceMs);
  };

  const startup = compile(true)
    .then(() => {
      if (closed) {
        if (initialEvent) resolveReady(initialEvent);
        return;
      }
      watcher = watch(rootDir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return schedule();
        const changedPath = resolve(rootDir, filename.toString());
        const relativePath = relative(outDir, changedPath);
        if (!relativePath.startsWith("..") && relativePath !== "") return;
        if (/\.(tsx?|mts|cts)$/.test(changedPath)
          || isCompilerConfigurationPath(rootDir, changedPath)
          || (options.graphql && (/\.(graphql|gql)$/.test(changedPath) || changedPath === schemaPath))) {
          schedule(relative(rootDir, changedPath));
        }
      });
      if (schemaPath && relative(rootDir, schemaPath).startsWith(`..${sep}`)) {
        let directory = dirname(schemaPath);
        while (!existsSync(directory) && dirname(directory) !== directory) directory = dirname(directory);
        schemaWatcher = watch(directory, { recursive: true }, (_eventType, filename) => {
          if (!filename || resolve(directory, filename.toString()) === schemaPath) schedule(schemaPath);
        });
      }
      if (initialEvent) resolveReady(initialEvent);
    })
    .catch((error: unknown) => {
      stopWatching();
      rejectReady(error);
    });

  return {
    ready,
    async close(): Promise<void> {
      stopWatching();
      // startup settles even when ready rejects, and closed startup never installs new watchers.
      await startup;
      await activeCompilation.catch(() => undefined);
    },
  };
}
