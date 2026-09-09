export interface CommandLock {
  version: 1;
  target: string;
  operationId: string;
}

export interface CommandLockStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CommandLockCoordinator {
  exclusive<T>(name: string, task: () => T | Promise<T>): Promise<T>;
}

export class CommandLockError extends Error {
  readonly code = "COMMAND_LOCK_UNAVAILABLE";
  constructor() { super("Command lock storage is unavailable or invalid"); this.name = "CommandLockError"; }
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 500) throw new CommandLockError();
  return value;
}

function decodeLock(value: unknown, target: string): CommandLock {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1
    || !("target" in value) || value.target !== target || !("operationId" in value)) {
    throw new CommandLockError();
  }
  return { version: 1, target, operationId: identifier(value.operationId) };
}

/** No unlocked localStorage fallback: supply Web Locks or an equivalent atomic coordinator. */
export function createDurableCommandLocks(options: {
  namespace: string;
  storage: CommandLockStorage;
  coordinator: CommandLockCoordinator;
}) {
  const namespace = identifier(options.namespace);
  const keyFor = (target: string) => `${namespace}:${encodeURIComponent(identifier(target))}`;
  const read = (target: string): CommandLock | null => {
    const value = options.storage.getItem(keyFor(target));
    if (value === null) return null;
    const parsed: unknown = JSON.parse(value);
    return decodeLock(parsed, target);
  };
  const exclusive = async <T>(target: string, task: () => T): Promise<T> => {
    try { return await options.coordinator.exclusive(keyFor(target), task); }
    catch { throw new CommandLockError(); }
  };
  return {
    get(target: string): Promise<CommandLock | null> {
      return exclusive(target, () => read(target));
    },
    acquire(target: string, operationId: string): Promise<{ acquired: boolean; lock: CommandLock }> {
      return exclusive(target, () => {
        identifier(operationId);
        const existing = read(target);
        if (existing !== null) return { acquired: false, lock: existing };
        const lock: CommandLock = { version: 1, target, operationId };
        options.storage.setItem(keyFor(target), JSON.stringify(lock));
        const persisted = read(target);
        if (persisted?.operationId !== operationId) throw new CommandLockError();
        return { acquired: true, lock };
      });
    },
    release(target: string, operationId: string, isCurrent: () => boolean): Promise<boolean> {
      return exclusive(target, () => {
        identifier(operationId);
        if (isCurrent() !== true) return false;
        const lock = read(target);
        if (lock === null || lock.operationId !== operationId) return false;
        options.storage.removeItem(keyFor(target));
        if (read(target) !== null) throw new CommandLockError();
        return true;
      });
    },
  };
}

export function createWebLockCoordinator(locks: LockManager): CommandLockCoordinator {
  return { exclusive: (name, task) => locks.request(name, { mode: "exclusive" }, task) };
}
