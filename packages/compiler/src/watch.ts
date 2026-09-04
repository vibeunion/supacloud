import { watch } from "node:fs";
import { relative, resolve } from "node:path";
import { createIncrementalCompiler } from "./incremental";
import type { WatchEvent, WatchHandle, WatchOptions } from "./types";

const DEFAULT_DEBOUNCE_MS = 100;

/** Watch a project and keep the last successful generated artifacts active on errors. */
export function watchProject(options: WatchOptions): WatchHandle {
  const rootDir = resolve(options.rootDir);
  const outDir = resolve(options.outDir);
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let compiling = false;
  let pending = false;
  const pendingPaths = new Set<string>();
  let watcher: ReturnType<typeof watch> | undefined;
  const incremental = createIncrementalCompiler();
  let initialEvent: WatchEvent | undefined;
  let resolveReady!: (event: WatchEvent) => void;
  let rejectReady!: (error: unknown) => void;

  const ready = new Promise<WatchEvent>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });

  const emit = (event: WatchEvent): void => {
    options.onEvent?.(event);
    if (event.initial) initialEvent = event;
  };

  const compile = async (initial: boolean, changedPaths: string[] = []): Promise<void> => {
    if (closed && !initial) return;
    if (compiling) {
      pending = true;
      return;
    }
    compiling = true;
    const startedAt = performance.now();
    options.onEvent?.({
      type: "compile-start",
      initial,
      durationMs: 0,
      diagnostics: [],
      written: [],
    });
    try {
      const result = await incremental.compile({ ...options, writeOnError: false }, changedPaths);
      const durationMs = Math.round(performance.now() - startedAt);
      const hasErrors = result.diagnostics.some((diagnostic) => diagnostic.severity === "error");
      emit({
        type: hasErrors ? "compile-error" : "compiled",
        initial,
        durationMs,
        diagnostics: result.diagnostics,
        written: result.written,
        stats: result.stats,
      });
    } catch (error) {
      rejectReady(error);
      throw error;
    } finally {
      compiling = false;
      if (pending && !closed) {
        pending = false;
        void compile(false, [...pendingPaths]);
        pendingPaths.clear();
      }
    }
  };

  const schedule = (changedPath?: string): void => {
    if (closed) return;
    if (changedPath) pendingPaths.add(changedPath);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void compile(false, [...pendingPaths]);
      pendingPaths.clear();
    }, debounceMs);
  };

  void compile(true)
    .then(() => {
      if (closed) return;
      watcher = watch(rootDir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return schedule();
        const changedPath = resolve(rootDir, filename.toString());
        const relativePath = relative(outDir, changedPath);
        if (!relativePath.startsWith("..") && relativePath !== "") return;
        if (/\.(tsx?|mts|cts)$/.test(changedPath)) schedule(relative(rootDir, changedPath));
      });
      if (initialEvent) resolveReady(initialEvent);
    })
    .catch(() => undefined);

  return {
    ready,
    async close(): Promise<void> {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher?.close();
      await ready.catch(() => undefined);
    },
  };
}
