import { afterEach, describe, expect, test } from "bun:test";
import {
  cancelActiveSqlQuery,
  clearActiveSqlQueriesForTests,
  runRegisteredSqlQuery,
  SqlQueryAlreadyRunningError,
} from "../../src/db/sql-query-registry";

describe("SQL query registry", () => {
  afterEach(() => {
    clearActiveSqlQueriesForTests();
  });

  test("cancels the registered query and removes it after execution settles", async () => {
    let rejectExecution!: (reason: Error) => void;
    let cancelCalls = 0;
    const query = {
      execute: () => new Promise<never>((_resolve, reject) => {
        rejectExecution = reject;
      }),
    };
    const cancel = async () => {
        cancelCalls += 1;
        rejectExecution(Object.assign(new Error("cancelled"), { code: "ERR_POSTGRES_QUERY_CANCELLED" }));
        return true;
    };
    const execution = runRegisteredSqlQuery({
      projectRef: "project-a",
      queryId: "18da2c53-48f9-47bc-a255-530adc1eef26",
      query,
      cancel,
      startedAt: performance.now() - 20,
    });

    const cancellation = await cancelActiveSqlQuery("project-a", "18da2c53-48f9-47bc-a255-530adc1eef26");

    expect(cancellation?.cancelled).toBe(true);
    expect(cancellation?.durationMs).toBeGreaterThanOrEqual(20);
    expect(cancelCalls).toBe(1);
    await expect(execution).rejects.toMatchObject({
      code: "QUERY_CANCELLED",
      message: "Query cancelled",
    });
    expect(await cancelActiveSqlQuery("project-a", "18da2c53-48f9-47bc-a255-530adc1eef26")).toBeNull();
  });

  test("isolates identical query IDs by project", async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let firstCancelCalls = 0;
    let secondCancelCalls = 0;
    const firstExecution = runRegisteredSqlQuery({
      projectRef: "project-a",
      queryId: "shared-query-id-123456",
      query: {
        execute: () => new Promise<void>((resolve) => { releaseFirst = resolve; }),
      },
      cancel: async () => { firstCancelCalls += 1; return true; },
      startedAt: performance.now(),
    });
    const secondExecution = runRegisteredSqlQuery({
      projectRef: "project-b",
      queryId: "shared-query-id-123456",
      query: {
        execute: () => new Promise<void>((resolve) => { releaseSecond = resolve; }),
      },
      cancel: async () => { secondCancelCalls += 1; return true; },
      startedAt: performance.now(),
    });

    expect((await cancelActiveSqlQuery("project-a", "shared-query-id-123456"))?.cancelled).toBe(true);
    expect((await cancelActiveSqlQuery("project-a", "shared-query-id-123456"))?.cancelled).toBe(true);
    expect(firstCancelCalls).toBe(1);
    expect(secondCancelCalls).toBe(0);

    releaseFirst();
    releaseSecond();
    await Promise.all([firstExecution, secondExecution]);
    expect(await cancelActiveSqlQuery("project-a", "shared-query-id-123456")).toBeNull();
    expect(await cancelActiveSqlQuery("project-b", "shared-query-id-123456")).toBeNull();
  });

  test("rejects a duplicate active query ID in the same project", async () => {
    let releaseExecution!: () => void;
    const firstExecution = runRegisteredSqlQuery({
      projectRef: "project-a",
      queryId: "duplicate-query-id-1234",
      query: {
        execute: () => new Promise<void>((resolve) => { releaseExecution = resolve; }),
      },
      cancel: async () => true,
      startedAt: performance.now(),
    });

    await expect(runRegisteredSqlQuery({
      projectRef: "project-a",
      queryId: "duplicate-query-id-1234",
      query: {
        execute: async () => {},
      },
      cancel: async () => true,
      startedAt: performance.now(),
    })).rejects.toBeInstanceOf(SqlQueryAlreadyRunningError);

    releaseExecution();
    await firstExecution;
  });

  test("shares one in-flight cancellation request", async () => {
    let releaseExecution!: () => void;
    let confirmCancellation!: (cancelled: boolean) => void;
    let cancelCalls = 0;
    const execution = runRegisteredSqlQuery({
      projectRef: "project-a",
      queryId: "shared-cancel-request-1234",
      query: {
        execute: () => new Promise<void>((resolve) => { releaseExecution = resolve; }),
      },
      cancel: () => {
        cancelCalls += 1;
        return new Promise<boolean>((resolve) => { confirmCancellation = resolve; });
      },
      startedAt: performance.now(),
    });

    const firstCancellation = cancelActiveSqlQuery("project-a", "shared-cancel-request-1234");
    const secondCancellation = cancelActiveSqlQuery("project-a", "shared-cancel-request-1234");
    confirmCancellation(true);

    expect((await firstCancellation)?.cancelled).toBe(true);
    expect((await secondCancellation)?.cancelled).toBe(true);
    expect(cancelCalls).toBe(1);
    releaseExecution();
    await execution;
  });

  test("allows cancellation retry when PostgreSQL returns false", async () => {
    let releaseExecution!: () => void;
    let cancelCalls = 0;
    const execution = runRegisteredSqlQuery({
      projectRef: "project-a",
      queryId: "unconfirmed-cancel-1234",
      query: {
        execute: () => new Promise<void>((resolve) => { releaseExecution = resolve; }),
      },
      cancel: async () => {
        cancelCalls += 1;
        return cancelCalls > 1;
      },
      startedAt: performance.now(),
    });

    expect(await cancelActiveSqlQuery("project-a", "unconfirmed-cancel-1234")).toMatchObject({
      cancelled: false,
    });
    expect(await cancelActiveSqlQuery("project-a", "unconfirmed-cancel-1234")).toMatchObject({
      cancelled: true,
    });
    expect(cancelCalls).toBe(2);
    releaseExecution();
    await execution;
  });

  test("preserves a PostgreSQL statement timeout without a confirmed cancellation", async () => {
    const timeoutError = Object.assign(
      new Error("canceling statement due to statement timeout"),
      { code: "ERR_POSTGRES_SERVER_ERROR", errno: "57014" },
    );

    await expect(runRegisteredSqlQuery({
      projectRef: "project-a",
      queryId: "statement-timeout-1234",
      query: { execute: async () => { throw timeoutError; } },
      cancel: async () => true,
      startedAt: performance.now(),
    })).rejects.toBe(timeoutError);
  });
});
