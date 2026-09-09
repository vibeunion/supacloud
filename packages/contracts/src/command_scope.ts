export interface CommandAttempt {
  readonly operationId: string;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  /** The callback must be synchronous; put storage mutations inside an owned lock operation. */
  commit(effect: () => undefined): boolean;
}

export interface CommandScope {
  readonly destroyed: boolean;
  begin(operationId: string): CommandAttempt;
  /** Invalidate pending work without destroying a reused component. */
  invalidate(): void;
  destroy(): void;
}

export function createCommandScope(): CommandScope {
  let destroyed = false;
  let current: AbortController | undefined;
  return {
    get destroyed() { return destroyed; },
    begin(operationId) {
      if (destroyed) throw new Error("Command scope is destroyed");
      if (typeof operationId !== "string" || !operationId.trim()) throw new TypeError("Invalid operation ID");
      current?.abort();
      const controller = new AbortController();
      current = controller;
      const isCurrent = () => !destroyed && current === controller && !controller.signal.aborted;
      return {
        operationId, signal: controller.signal, isCurrent,
        commit(effect) {
          if (!isCurrent()) return false;
          effect();
          return true;
        },
      };
    },
    invalidate() {
      current?.abort();
      current = undefined;
    },
    destroy() {
      destroyed = true;
      current?.abort();
      current = undefined;
    },
  };
}
