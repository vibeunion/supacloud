export interface LinuxPidfdOperations {
  open(pid: number): number;
  sendSignal(pidfd: number, signal: number): number;
  close(pidfd: number): void;
}

const PIDFD_SEND_SIGNAL_SYSCALL = 424;
const PIDFD_OPEN_SYSCALL = 434;

async function linuxPidfdOperations(): Promise<LinuxPidfdOperations> {
  if (process.platform !== "linux" || !["arm64", "x64"].includes(process.arch)) {
    throw new Error("Linux pidfd is unavailable on this platform");
  }
  // Bun does not expose pidfd here, so termination uses the kernel handle through libc.
  const { dlopen, FFIType } = await import("bun:ffi");
  const libc = dlopen("libc.so.6", {
    syscall: {
      args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64],
      returns: FFIType.i64,
    },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  });
  return {
    open(pid) {
      const pidfd = Number(libc.symbols.syscall(PIDFD_OPEN_SYSCALL, pid, 0, 0, 0));
      if (pidfd < 0) libc.close();
      return pidfd;
    },
    sendSignal(pidfd, signal) {
      return Number(libc.symbols.syscall(PIDFD_SEND_SIGNAL_SYSCALL, pidfd, signal, 0, 0));
    },
    close(pidfd) {
      libc.symbols.close(pidfd);
      libc.close();
    },
  };
}

export async function killVerifiedProcessWithPidfd(
  pid: number,
  verifyTarget: () => Promise<void>,
  operations?: LinuxPidfdOperations,
): Promise<void> {
  const pidfdOperations = operations ?? await linuxPidfdOperations();
  const pidfd = pidfdOperations.open(pid);
  if (pidfd < 0) throw new Error("Failed to open PostgREST identity probe pidfd");
  try {
    await verifyTarget();
    if (pidfdOperations.sendSignal(pidfd, 9) !== 0) {
      throw new Error("Failed to signal PostgREST identity probe pidfd");
    }
  } finally {
    pidfdOperations.close(pidfd);
  }
}
