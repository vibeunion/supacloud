import { expect, test } from "bun:test";
import {
  FrontendDeploymentLockReleaseError,
  createFrontendDeploymentLock,
} from "../../src/services/frontend-deployment-lock";

function barrier(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  return { wait: new Promise<void>((resolve) => { release = resolve; }), release };
}

class FakeAdvisoryLocks {
  private readonly tails = new Map<string, Promise<void>>();
  releaseCount = 0;
  closeCount = 0;

  reserve(options: { unlock?: "false" | "throw" } = {}) {
    let held: { key: string; release: () => void } | undefined;
    const releaseConnection = () => {
      this.releaseCount += 1;
      held?.release();
    };
    const closeConnection = () => {
      this.closeCount += 1;
      held?.release();
    };
    const connection = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const statement = strings.join("?");
        const key = String(values[0]);
        if (statement.includes("pg_advisory_lock(")) {
          const previous = this.tails.get(key) ?? Promise.resolve();
          let release!: () => void;
          const current = new Promise<void>((resolve) => { release = resolve; });
          this.tails.set(key, previous.then(() => current));
          await previous;
          held = { key, release };
          return [];
        }
        if (statement.includes("pg_advisory_unlock(")) {
          if (options.unlock === "throw") throw new Error("database disconnected during unlock");
          if (options.unlock === "false") return [{ unlocked: false }];
          held?.release();
          if (held && this.tails.get(held.key)) this.tails.delete(held.key);
          held = undefined;
          return [{ unlocked: true }];
        }
        return [];
      },
      { release: releaseConnection, close: async () => { closeConnection(); } },
    );
    return connection;
  }
}

function fakePool(locks: FakeAdvisoryLocks, options: { unlock?: "false" | "throw" } = {}) {
  return { reserve: async () => locks.reserve(options) as never };
}

test("serializes independent Management instances through a PostgreSQL session lock", async () => {
  const locks = new FakeAdvisoryLocks();
  const firstInstance = createFrontendDeploymentLock(fakePool(locks));
  const secondInstance = createFrontendDeploymentLock(fakePool(locks));
  const firstEntered = barrier();
  const firstRelease = barrier();
  let secondEntered = false;

  const first = firstInstance("abcdefghijklmnopqrst", "fa-web", async () => {
    firstEntered.release();
    await firstRelease.wait;
  });
  await firstEntered.wait;
  const second = secondInstance("abcdefghijklmnopqrst", "fa-web", async () => {
    secondEntered = true;
  });
  await Promise.resolve();
  expect(secondEntered).toBe(false);
  firstRelease.release();
  await Promise.all([first, second]);
  expect(secondEntered).toBe(true);
  expect(locks.releaseCount).toBe(2);
  expect(locks.closeCount).toBe(0);
});

test("allows same-deployment nested operations without acquiring another session", async () => {
  const locks = new FakeAdvisoryLocks();
  let reservations = 0;
  const lock = createFrontendDeploymentLock({
    reserve: async () => {
      reservations += 1;
      return locks.reserve() as never;
    },
  });
  await lock("abcdefghijklmnopqrst", "fa-web", () =>
    lock("abcdefghijklmnopqrst", "fa-web", async () => "done"));
  expect(reservations).toBe(1);
});

for (const unlock of ["false", "throw"] as const) {
  test(`fails closed when advisory unlock returns ${unlock}`, async () => {
    const locks = new FakeAdvisoryLocks();
    const lock = createFrontendDeploymentLock(fakePool(locks, { unlock }));
    await expect(lock("abcdefghijklmnopqrst", "fa-web", async () => "success"))
      .rejects.toBeInstanceOf(FrontendDeploymentLockReleaseError);
    expect(locks.closeCount).toBe(1);
    expect(locks.releaseCount).toBe(0);
  });
}

test("preserves an operation failure when advisory unlock also fails", async () => {
  const locks = new FakeAdvisoryLocks();
  const lock = createFrontendDeploymentLock(fakePool(locks, { unlock: "throw" }));
  const operationError = new Error("operation failed");
  await expect(lock("abcdefghijklmnopqrst", "fa-web", async () => { throw operationError; }))
    .rejects.toBe(operationError);
  expect(locks.closeCount).toBe(1);
  expect(locks.releaseCount).toBe(0);
});
