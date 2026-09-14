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

for (const failure of [false, true]) {
  test(`reacquires a session for inherited callbacks after the parent ${failure ? "fails" : "finishes"}`, async () => {
    const locks = new FakeAdvisoryLocks();
    const pool = fakePool(locks);
    let reservations = 0;
    const lock = createFrontendDeploymentLock({
      reserve: async () => {
        reservations++;
        return pool.reserve();
      },
    });
    const resume = barrier();
    let delayed: Promise<string> | undefined;
    const parentError = new Error("parent failed");
    const parent = lock("abcdefghijklmnopqrst", "fa-web", async () => {
      delayed = resume.wait.then(() =>
        lock("abcdefghijklmnopqrst", "fa-web", async () => "late result"));
      if (failure) throw parentError;
      return "parent result";
    });
    try {
      if (failure) await expect(parent).rejects.toBe(parentError);
      else expect(await parent).toBe("parent result");
      expect(locks.releaseCount).toBe(1);
      resume.release();
      expect(await delayed).toBe("late result");
      expect(reservations).toBe(2);
      expect(locks.releaseCount).toBe(2);
    } finally {
      resume.release();
      await delayed;
    }
  });
}

for (const fails of [false, true]) {
  test(`keeps the session until unawaited nested work ${fails ? "fails" : "finishes"}`, async () => {
    const locks = new FakeAdvisoryLocks();
    const lock = createFrontendDeploymentLock(fakePool(locks));
    const competingLock = createFrontendDeploymentLock(fakePool(locks));
    const childEntered = barrier();
    const childRelease = barrier();
    const childError = new Error("nested operation failed");
    let nested: Promise<string> | undefined;
    let parentSettled = false;
    let competitorEntered = false;
    const parent = lock("abcdefghijklmnopqrst", "fa-web", async () => {
      nested = lock("abcdefghijklmnopqrst", "fa-web", async () => {
        childEntered.release();
        await childRelease.wait;
        if (fails) throw childError;
        return "child";
      });
      void nested.catch(() => {});
      return "parent";
    });
    const settlement = parent.then(() => { parentSettled = true; }, () => { parentSettled = true; });
    await childEntered.wait;
    const competitor = competingLock("abcdefghijklmnopqrst", "fa-web", async () => {
      competitorEntered = true;
    });
    try {
      await Bun.sleep(0);
      expect(parentSettled).toBe(false);
      expect(competitorEntered).toBe(false);
      expect(locks.releaseCount).toBe(0);
      childRelease.release();
      if (fails) await expect(parent).rejects.toBe(childError);
      else expect(await parent).toBe("parent");
      await competitor;
      expect(competitorEntered).toBe(true);
      expect(locks.releaseCount).toBe(2);
    } finally {
      childRelease.release();
      await Promise.allSettled([parent, nested, competitor, settlement]);
    }
  });
}

test("preserves successful empty and falsy operation results", async () => {
  const locks = new FakeAdvisoryLocks();
  const lock = createFrontendDeploymentLock(fakePool(locks));
  for (const value of [undefined, null, false, 0, ""]) {
    expect(await lock("abcdefghijklmnopqrst", "fa-web", async () => value)).toBe(value);
  }
  expect(locks.releaseCount).toBe(5);
});

test("drains descendants admitted while waiting and preserves the original parent failure", async () => {
  const locks = new FakeAdvisoryLocks();
  const lock = createFrontendDeploymentLock(fakePool(locks));
  const startDescendant = barrier();
  const descendantEntered = barrier();
  const finishDescendant = barrier();
  const parentError = new Error("original parent failure");
  let parentSettled = false;
  let nested: Promise<void> | undefined;
  let descendant: Promise<void> | undefined;
  const parent = lock("abcdefghijklmnopqrst", "fa-web", async () => {
    nested = lock("abcdefghijklmnopqrst", "fa-web", async () => {
      await startDescendant.wait;
      descendant = lock("abcdefghijklmnopqrst", "fa-web", async () => {
        descendantEntered.release();
        await finishDescendant.wait;
        throw new Error("descendant failure");
      });
      void descendant.catch(() => {});
    });
    throw parentError;
  });
  const settlement = parent.then(() => { parentSettled = true; }, () => { parentSettled = true; });
  try {
    await Bun.sleep(0);
    expect(parentSettled).toBe(false);
    startDescendant.release();
    await descendantEntered.wait;
    await nested;
    await Bun.sleep(0);
    expect(parentSettled).toBe(false);
    expect(locks.releaseCount).toBe(0);
    finishDescendant.release();
    await expect(parent).rejects.toBe(parentError);
    expect(locks.releaseCount).toBe(1);
  } finally {
    startDescendant.release();
    finishDescendant.release();
    await Promise.allSettled([parent, nested, descendant, settlement]);
  }
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
