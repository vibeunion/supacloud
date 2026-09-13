import { describe, expect, test } from "bun:test";
import {
  createQueueWorkerTransport,
  createWorker,
  WorkerRegistrationError,
  WorkerReceiptUnconfirmedError,
  type CompiledModule,
  type WorkerClaim,
  type WorkerQueuePort,
  type WorkerTransport,
} from "./index";

type Claim = { id: string; job: string; payload: unknown };
type Receipt = { kind: "ack" | "fail"; value: unknown };

function moduleWithJobs(name: string, jobs: readonly string[], run?: (input: unknown) => unknown | Promise<unknown>): CompiledModule {
  const services: Record<string, unknown> = {};
  for (const job of jobs) {
    services[job] = { run: run ?? ((input: unknown) => ({ job, input })) };
  }
  return {
    name,
    createServices: () => services,
    controllers: [],
    jobs: jobs.map(job => ({
      className: `${job}Job`, name: job, serviceKey: job, scope: "application" as const,
    })),
  };
}

function transport(overrides: Partial<WorkerTransport<Claim, Receipt>> = {}): WorkerTransport<Claim, Receipt> {
  return {
    claim: async () => null,
    ack: async (_claim, output) => ({ kind: "ack", value: output }),
    fail: async (_claim, error) => ({ kind: "fail", value: error }),
    ...overrides,
  };
}

function mapClaim(claim: Claim): WorkerClaim {
  return { id: claim.id, jobName: claim.job, input: claim.payload };
}

describe("SupaCloud worker", () => {
  test("registers jobs atomically and rejects duplicate modules or jobs", () => {
    const worker = createWorker({ transport: transport() });
    const first = moduleWithJobs("first", ["reports.run"]);
    worker.registerModule(first);
    expect(worker.jobNames).toEqual(["reports.run"]);

    expect(() => worker.registerModule(first)).toThrowError(WorkerRegistrationError);
    expect(() => worker.registerModule(moduleWithJobs("second", ["reports.run"]))).toThrowError(WorkerRegistrationError);
    expect(() => worker.registerModule(moduleWithJobs("broken", ["new.job", "new.job"]))).toThrowError(WorkerRegistrationError);
    expect(worker.jobNames).toEqual(["reports.run"]);
  });

  test("rejects invalid job metadata before committing the module", () => {
    const worker = createWorker({ transport: transport() });
    const source = moduleWithJobs("invalid", ["invalid.job"]);
    const job = source.jobs?.[0];
    if (!job) throw new Error("Expected a test job");
    const invalid = {
      ...source,
      jobs: [{ ...job, scope: "unsupported" as never }],
    } satisfies CompiledModule;

    expect(() => worker.registerModule(invalid)).toThrowError(WorkerRegistrationError);
    expect(worker.jobNames).toEqual([]);
  });

  test("executes a registered job and returns the platform receipt unchanged", async () => {
    const worker = createWorker<Claim, Receipt>({
      modules: [moduleWithJobs("reports", ["reports.run"])],
      transport: transport(),
      mapClaim,
      workerId: "worker-1",
    });
    await worker.start();
    try {
      const result = await worker.processClaim({ id: "claim-1", job: "reports.run", payload: { value: 7 } });
      expect(result).toMatchObject({
        claimId: "claim-1", jobName: "reports.run", status: "acknowledged",
        receipt: { kind: "ack", value: { job: "reports.run", input: { value: 7 } } },
      });
    } finally {
      await worker.stop();
    }
  });

  test("fails unknown jobs through the adapter and keeps the receipt type", async () => {
    const failures: unknown[] = [];
    const worker = createWorker<Claim, Receipt>({
      modules: [moduleWithJobs("reports", ["reports.run"])],
      transport: transport({
        fail: async (_claim, error) => { failures.push(error); return { kind: "fail", value: error }; },
      }),
      mapClaim,
    });
    await worker.start();
    try {
      const result = await worker.processClaim({ id: "claim-2", job: "missing", payload: null });
      expect(result.status).toBe("failed");
      expect(result.receipt.kind).toBe("fail");
      expect(failures[0]).toMatchObject({ code: "WORKER_INVALID_JOB" });
    } finally {
      await worker.stop();
    }
  });

  test("does not fail a claim again when acknowledgement is unconfirmed", async () => {
    let failures = 0;
    const worker = createWorker<Claim, Receipt>({
      modules: [moduleWithJobs("reports", ["reports.run"])],
      transport: transport({
        ack: async () => { throw new Error("ack response lost"); },
        fail: async (_claim, error) => {
          failures++;
          return { kind: "fail", value: error };
        },
      }),
      mapClaim,
    });
    await worker.start();
    try {
      const error = await worker.processClaim({ id: "claim-ack-uncertain", job: "reports.run", payload: null })
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(WorkerReceiptUnconfirmedError);
      expect(error).toMatchObject({
        code: "WORKER_RECEIPT_UNCONFIRMED",
        operation: "ack",
        claimId: "claim-ack-uncertain",
        mutationMayHaveApplied: true,
      });
      expect(failures).toBe(0);
    } finally {
      await worker.stop();
    }
  });

  test("adapts a queue port while preserving its typed platform receipt", async () => {
    type QueueMessage = { id: string; payload: unknown };
    const receipts: string[] = [];
    let delivered = false;
    const queue: WorkerQueuePort<QueueMessage, Receipt> = {
      receive: async (options) => {
        expect(options).toEqual({ visibilityTimeoutSec: 45 });
        if (delivered) return null;
        delivered = true;
        return { id: "message-1", payload: { jobName: "reports.run", input: { value: 9 } } };
      },
      ack: async (messageId) => {
        receipts.push(`ack:${messageId}`);
        return { kind: "ack", value: messageId };
      },
      fail: async (messageId, options) => {
        receipts.push(`fail:${messageId}:${options?.error ?? ""}`);
        return { kind: "fail", value: messageId };
      },
    };
    const platformTransport = createQueueWorkerTransport<QueueMessage, Claim, Receipt>({
      queue,
      receive: { visibilityTimeoutSec: 45 },
      decodeClaim: (message) => {
        const payload = message.payload as { jobName: string; input: unknown };
        return { id: message.id, job: payload.jobName, payload: payload.input };
      },
      messageId: (claim) => claim.id,
    });
    const claim = await platformTransport.claim(new AbortController().signal);
    if (claim === null) throw new Error("Expected a queue claim");
    const worker = createWorker<Claim, Receipt>({
      modules: [moduleWithJobs("reports", ["reports.run"])],
      transport: platformTransport,
      mapClaim,
    });
    await worker.start();
    try {
      const result = await worker.processClaim(claim);
      expect(result).toMatchObject({ status: "acknowledged", receipt: { kind: "ack", value: "message-1" } });
      expect(receipts).toEqual(["ack:message-1"]);
    } finally {
      await worker.stop();
    }
  });

  test("stops gracefully after in-flight work acknowledges", async () => {
    let started = false;
    let release!: () => void;
    const running = new Promise<void>(resolve => { release = resolve; });
    let worker: ReturnType<typeof createWorker<Claim, Receipt>> | undefined;
    const startedPromise = new Promise<void>(resolve => {
      const created = createWorker<Claim, Receipt>({
        modules: [moduleWithJobs("reports", ["reports.run"], async () => {
          started = true;
          resolve();
          await running;
          return "done";
        })],
        transport: transport({
          claim: async () => started ? null : { id: "claim-3", job: "reports.run", payload: null },
        }),
        mapClaim,
      });
      worker = created;
      void created.start();
    });
    await startedPromise;
    if (!worker) throw new Error("Expected worker");
    const stopping = worker.stop();
    expect(worker.state).toBe("stopping");
    release();
    await stopping;
    expect(worker.state).toBe("stopped");
    await expect(worker.stop()).resolves.toBeUndefined();
  });

  test("does not start polling when stop intervenes during startup", async () => {
    let claims = 0;
    let destroyed = 0;
    const module: CompiledModule = {
      ...moduleWithJobs("reports", ["reports.run"]),
      createServices: () => ({ service: { onDestroy: () => { destroyed++; } } }),
      jobs: [{ className: "ReportsJob", name: "reports.run", serviceKey: "service", scope: "application" }],
    };
    const worker = createWorker({
      modules: [module],
      transport: transport({ claim: async () => { claims++; return null; } }),
    });
    const starting = worker.start();
    const stopping = worker.stop();
    await Promise.all([starting, stopping]);
    expect(worker.state).toBe("stopped");
    expect(claims).toBe(0);
    expect(destroyed).toBe(1);
  });
});
