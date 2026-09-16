export interface WorkerHandle {
  stopWorker(): Promise<void>;
}

/** Own startup/shutdown only. Queue leases and retries stay with pgflow. */
export function createLifecycle(start: () => Promise<WorkerHandle>) {
  let state:
    | "idle"
    | "starting"
    | "running"
    | "stopping"
    | "stopped"
    | "failed" = "idle";
  let startup: Promise<WorkerHandle> | undefined;
  let stopping: Promise<void> | undefined;
  return {
    get state() {
      return state;
    },
    start(): Promise<void> {
      if (state === "stopping" || state === "stopped" || state === "failed") {
        return Promise.reject(new Error("WORKER_RESTART_REQUIRES_NEW_PROCESS"));
      }
      if (!startup) {
        state = "starting";
        startup = Promise.resolve()
          .then(start)
          .then(
            (handle) => {
              if (state === "starting") state = "running";
              return handle;
            },
            () => {
              state = "failed";
              throw new Error("WORKER_START_FAILED");
            },
          );
      }
      return startup.then(() => undefined);
    },
    stop(): Promise<void> {
      if (stopping) return stopping;
      if (!startup) {
        state = "stopped";
        return Promise.resolve();
      }
      state = "stopping";
      stopping = startup
        .then((handle) => handle.stopWorker())
        .then(
          () => {
            state = "stopped";
          },
          () => {
            state = "failed";
            throw new Error("WORKER_STOP_FAILED");
          },
        );
      return stopping;
    },
  };
}
