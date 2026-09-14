export type SpawnInvocation = Bun.SpawnOptions.SpawnOptions<
  Bun.SpawnOptions.Writable,
  Bun.SpawnOptions.Readable,
  Bun.SpawnOptions.Readable
> & { cmd: string[] };

export function redirectSpawn(rewrite: (invocation: SpawnInvocation) => string[]) {
  const nativeSpawn = Bun.spawn;
  const children = new Set<Bun.Subprocess<
    Bun.SpawnOptions.Writable,
    Bun.SpawnOptions.Readable,
    Bun.SpawnOptions.Readable
  >>();

  function spawn<
    const In extends Bun.SpawnOptions.Writable = "ignore",
    const Out extends Bun.SpawnOptions.Readable = "pipe",
    const Err extends Bun.SpawnOptions.Readable = "inherit",
  >(
    command: string[] | (Bun.SpawnOptions.SpawnOptions<In, Out, Err> & { cmd: string[] }),
    options?: Bun.SpawnOptions.SpawnOptions<In, Out, Err>,
  ): Bun.Subprocess<In, Out, Err> {
    const invocation = Array.isArray(command) ? { ...options, cmd: command } : command;
    const child = nativeSpawn({ ...invocation, cmd: rewrite(invocation) });
    children.add(child);
    void child.exited.then(
      () => children.delete(child),
      () => children.delete(child),
    );
    return child;
  }

  return {
    spawn: spawn satisfies typeof Bun.spawn,
    async close() {
      const active = [...children];
      for (const child of active) child.kill();
      await Promise.allSettled(active.map((child) => child.exited));
    },
  };
}
