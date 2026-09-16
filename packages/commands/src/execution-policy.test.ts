import { expect, test } from "bun:test";
import { createExecutionPolicy } from "./execution-policy";

test("read retries are explicit and preserve result types", async () => {
  let calls = 0;
  const policy = createExecutionPolicy({ kind: "read", retry: { maxAttempts: 3, delayMs: 1, classify: () => "retry" } });
  expect(await policy.execute(async () => {
    if (++calls < 3) throw new Error("transient");
    return { count: 3 };
  })).toEqual({ count: 3 });
  expect(calls).toBe(3);
});

test("commands never retry a generic transient or unknown write outcome", async () => {
  for (const decision of ["retry", "stop"] as const) {
    let calls = 0;
    const policy = createExecutionPolicy({ kind: "command", retry: { maxAttempts: 3, delayMs: 1, classify: () => decision } });
    await expect(policy.execute(async () => { calls++; throw new Error("unknown"); })).rejects.toThrow("unknown");
    expect(calls).toBe(1);
  }
});

test("only driver-confirmed rollback permits a write retry", async () => {
  let attempts = 0;
  const policy = createExecutionPolicy({ kind: "command", retry: { maxAttempts: 2, delayMs: 1, classify: () => "rolled-back" } });
  expect(await policy.execute(async () => {
    if (++attempts === 1) throw new Error("serialization failure rolled back");
    return "receipt";
  })).toBe("receipt");
  expect(attempts).toBe(2);
});

test("timeout signals cancellation but retains ownership until a write settles", async () => {
  const finished = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let attempts = 0, settled = false;
  const policy = createExecutionPolicy({
    kind: "command", timeoutMs: 5,
    retry: { maxAttempts: 3, delayMs: 1, classify: () => "rolled-back" },
  });
  const pending = policy.execute(async (signal) => {
    attempts++;
    signal.addEventListener("abort", () => started.resolve(), { once: true });
    await finished.promise;
    return "driver settled";
  }).finally(() => { settled = true; });
  const rejected = pending.then(() => undefined, (error: unknown) => error);
  await started.promise;
  expect(settled).toBe(false);
  finished.resolve();
  expect(await rejected).toMatchObject({ code: "COMMAND_OUTCOME_UNKNOWN" });
  expect(attempts).toBe(1);
});

test("circuit excludes business failures and allows one half-open probe", async () => {
  const policy = createExecutionPolicy({
    kind: "read", circuit: { failureThreshold: 1, resetAfterMs: 5, isFailure: (error) => error instanceof Error && error.message === "offline" },
  });
  await expect(policy.execute(async () => { throw new Error("denied"); })).rejects.toThrow("denied");
  await expect(policy.execute(async () => { throw new Error("offline"); })).rejects.toThrow("offline");
  await expect(policy.execute(async () => "wrong")).rejects.toMatchObject({ code: "CIRCUIT_OPEN" });
  await Bun.sleep(10);
  const resume = Promise.withResolvers<string>();
  const probe = policy.execute(() => resume.promise);
  await expect(policy.execute(async () => "wrong")).rejects.toMatchObject({ code: "CIRCUIT_OPEN" });
  resume.resolve("recovered");
  expect(await probe).toBe("recovered");
  expect(await policy.execute(async () => "healthy")).toBe("healthy");
});

test("pre-aborted requests never run and invalid options fail at construction", async () => {
  const parent = new AbortController();
  parent.abort();
  let calls = 0;
  await expect(createExecutionPolicy({ kind: "read" }).execute(async () => ++calls, parent.signal))
    .rejects.toMatchObject({ code: "EXECUTION_ABORTED" });
  expect(calls).toBe(0);
  expect(() => createExecutionPolicy({ kind: "read", timeoutMs: -1 })).toThrow();
});
