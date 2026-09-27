import { expect, test } from "bun:test";
import { decodeDurableCommandReceipt, type DurableCommandReceipt } from "@supacloud/contracts";
import {
  ApplicationError, bindCompiledCommand, createApplication, createWorker, requireIdempotencyKey,
  type CompiledCommandCallContext, type CompiledModule, type WorkerClaim,
} from "./index";
import {
  createFulfillment, type FulfillmentSteps, type OrderInput, type OrderResult,
  type PaymentResult, type ReservationInput, type ReservationResult,
} from "./examples/fulfillment";

function order(value: unknown): OrderInput {
  if (!value || typeof value !== "object" || !("orderId" in value) || typeof value.orderId !== "string") {
    throw new TypeError("Invalid order");
  }
  return { orderId: value.orderId };
}
function reservation(value: unknown): ReservationResult {
  if (!value || typeof value !== "object" || !("reservationId" in value) || typeof value.reservationId !== "string") {
    throw new TypeError("Invalid reservation");
  }
  return { reservationId: value.reservationId };
}
function payment(value: unknown): PaymentResult {
  if (!value || typeof value !== "object" || !("outcome" in value)
    || (value.outcome !== "paid" && value.outcome !== "declined")) throw new TypeError("Invalid payment");
  return { outcome: value.outcome };
}
function context(key = "order-42", actorId = "actor", allowed = true): CompiledCommandCallContext {
  return {
    request: new Request("https://example.test/fulfill", { headers: { "idempotency-key": key } }),
    requestContext: { tenantId: "tenant", actorId, allowed },
  };
}
function identity(value: unknown) {
  if (!value || typeof value !== "object" || !("tenantId" in value) || typeof value.tenantId !== "string"
    || !("actorId" in value) || typeof value.actorId !== "string" || !("allowed" in value) || typeof value.allowed !== "boolean") {
    throw new Error("Missing verified identity");
  }
  return { tenantId: value.tenantId, actorId: value.actorId, allowed: value.allowed };
}

// Deterministic adapter double: no assertion about database atomicity or crash persistence.
function fixture() {
  const effects: string[] = [], authorizations: string[] = [], aspects: string[] = [];
  const receipts = new Map<string, DurableCommandReceipt<unknown>>();
  const inputs = new Map<string, string>();
  let outcome: "paid" | "declined" | "unknown" | "audit-pending" | "throws" = "paid";
  let denied: string | undefined;
  let pendingStep: keyof FulfillmentSteps | undefined;
  let releaseFails = false;
  function bind<Input, Result>(
    name: keyof FulfillmentSteps, moduleName: string, decode: (value: unknown) => Result,
    execute: (input: Input) => Result,
  ) {
    return bindCompiledCommand<Input, DurableCommandReceipt<Result>>({
      module: {
        name: moduleName,
        commands: [{
          className: name, name: `${moduleName}.${name}`, permission: `${moduleName}.${name}`,
          transaction: name === "charge" ? "none" : "required",
          idempotency: "required", audit: name, rpc: name,
        }],
        aspects: [(_context, next) => { aspects.push(name); return next(); }],
      },
      command: name,
      governance: {
        authorize: (invocation) => {
          const actor = identity(invocation.requestContext);
          authorizations.push(`${actor.actorId}:${name}`);
          if (!actor.allowed || denied === name) throw new ApplicationError("Denied", {
            status: 403, code: "COMMAND_FORBIDDEN",
          });
        },
        rpc: { [name]: {
          capabilities: { transaction: name !== "charge", idempotency: true, audit: true },
          execute: async (invocation, next) => {
            const actor = identity(invocation.requestContext);
            const operationId = requireIdempotencyKey(invocation);
            const key = JSON.stringify([actor.tenantId, actor.actorId, invocation.command.name, operationId]);
            const fingerprint = JSON.stringify(invocation.input.body);
            const existing = receipts.get(key);
            if (existing) {
              if (inputs.get(key) !== fingerprint) throw new Error("Conflicting operation input");
              return existing;
            }
            const result = await next();
            receipts.set(key, decodeDurableCommandReceipt(result, decode));
            inputs.set(key, fingerprint);
            return result;
          },
        } },
      },
      handler: (input, ctx) => {
        effects.push(name);
        const actor = identity(ctx.requestContext);
        const operationId = ctx.request.headers.get("idempotency-key")!;
        const reference = {
          tenantId: actor.tenantId, actorId: actor.actorId, command: `${moduleName}.${name}`,
          operationId, dispatchKey: `${name}:${operationId}`,
        };
        if (name === "charge" && outcome === "throws") throw new Error("Connection lost; outcome unknown");
        if ((name === "charge" && outcome === "unknown") || pendingStep === name) {
          return { ...reference, status: "unknown", audit: "pending" };
        }
        if (name === "release" && releaseFails) throw new Error("Release failed");
        return {
          ...reference, status: "confirmed",
          audit: name === "charge" && outcome === "audit-pending" ? "pending" : "complete",
          result: execute(input),
        };
      },
      decode: (value) => decodeDurableCommandReceipt(value, decode),
    });
  }
  const steps: FulfillmentSteps = {
    reserve: bind<OrderInput, ReservationResult>("reserve", "inventory", reservation,
      (input) => ({ reservationId: `reservation:${input.orderId}` })),
    charge: bind<ReservationInput, PaymentResult>("charge", "payments", payment,
      () => ({ outcome: outcome === "declined" ? "declined" : "paid" })),
    confirm: bind<ReservationInput, OrderResult>("confirm", "orders", order,
      (input) => ({ orderId: input.orderId })),
    release: bind<ReservationInput, OrderResult>("release", "inventory", order,
      (input) => ({ orderId: input.orderId })),
  };
  return {
    workflow: createFulfillment(steps), effects, authorizations, aspects,
    setOutcome(value: typeof outcome) { outcome = value; },
    deny(value: string) { denied = value; },
    pending(value: keyof FulfillmentSteps) { pendingStep = value; },
    failRelease() { releaseFails = true; },
    confirmPayment() {
      for (const [key, receipt] of receipts) {
        if (receipt.command === "payments.charge") receipts.set(key, {
          ...receipt, status: "confirmed", audit: "complete", result: { outcome: "paid" },
        });
      }
    },
  };
}

test("one cross-module composition serves HTTP, event, schedule and trusted CLI hosts", async () => {
  const f = fixture();
  const invoke = (input: unknown, ctx: CompiledCommandCallContext) => f.workflow.execute(order(input), ctx);
  const httpModule: CompiledModule = {
    name: "http", createServices: () => ({
      controller: { fulfill: ({ body, request, requestContext }: { body: unknown; request: Request; requestContext: unknown }) =>
        invoke(body, { request, requestContext }) },
    }),
    controllers: [{ path: "/", serviceKey: "controller", scope: "application",
      routes: [{ method: "POST", path: "fulfill", handler: "fulfill" }] }],
  };
  const app = createApplication({ modules: [httpModule], requestContext: () => context().requestContext });
  const response = await app.handle(new Request("http://localhost/fulfill", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "order-42" },
    body: JSON.stringify({ orderId: "42" }),
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "completed", orderId: "42" });

  const workerModule: CompiledModule = {
    name: "worker", controllers: [], createServices: () => ({}),
    createJobScope: (_services, requestContext) => ({
      job: { run: (input: unknown) => invoke(input, { ...context(), requestContext }) },
    }),
    jobs: ["event", "schedule"].map((name) => ({
      className: `${name}Job`, name, serviceKey: "job", scope: "job" as const,
    })),
  };
  const worker = createWorker<WorkerClaim, unknown>({
    modules: [workerModule], requestContext: () => context().requestContext,
    transport: { claim: async () => null, ack: (_claim, output) => output, fail: (_claim, error) => { throw error; } },
  });
  await worker.start();
  try {
    for (const jobName of ["event", "schedule"]) {
      const result = await worker.processClaim({ id: jobName, jobName, input: { orderId: "42" } });
      expect(result).toMatchObject({ status: "acknowledged", receipt: { status: "completed", orderId: "42" } });
    }
  } finally {
    await worker.stop();
  }
  expect(await invoke({ orderId: "42" }, context())).toEqual({ status: "completed", orderId: "42" });
  expect(f.effects).toEqual(["reserve", "charge", "confirm"]);
  expect(f.aspects).toEqual(f.effects);
  expect(f.authorizations).toEqual(Array.from({ length: 4 }, () => ["actor:reserve", "actor:charge", "actor:confirm"]).flat());
});

test("a repeated composition reauthorizes every step and rejects changed inputs", async () => {
  const f = fixture();
  await f.workflow.execute({ orderId: "42" }, context());
  f.deny("charge");
  await expect(f.workflow.execute({ orderId: "42" }, context())).rejects.toMatchObject({ code: "COMMAND_FORBIDDEN" });
  await expect(f.workflow.execute({ orderId: "43" }, context())).rejects.toThrow("Conflicting operation input");
  expect(f.effects).toEqual(["reserve", "charge", "confirm"]);
});

test("unknown or audit-pending payment stops progression; a confirmed recovery resumes from receipts", async () => {
  for (const state of ["unknown", "audit-pending"] as const) {
    const f = fixture();
    f.setOutcome(state);
    expect(await f.workflow.execute({ orderId: "42" }, context())).toEqual({
      status: "pending", step: "charge", operationId: "order-42",
    });
    await f.workflow.execute({ orderId: "42" }, context());
    expect(f.effects).toEqual(["reserve", "charge"]);
    // Represents the existing recovery handler confirming the host-owned durable receipt.
    f.confirmPayment();
    expect(await f.workflow.execute({ orderId: "42" }, context())).toEqual({ status: "completed", orderId: "42" });
    expect(f.effects).toEqual(["reserve", "charge", "confirm"]);
  }
});

test("only confirmed rejection invokes independently authorized compensation", async () => {
  const f = fixture();
  f.setOutcome("declined");
  f.deny("release");
  await expect(f.workflow.execute({ orderId: "42" }, context())).rejects.toMatchObject({ code: "COMMAND_FORBIDDEN" });
  expect(f.effects).toEqual(["reserve", "charge"]);
  f.deny("");
  expect(await f.workflow.execute({ orderId: "42" }, context())).toEqual({ status: "declined", orderId: "42" });
  await f.workflow.execute({ orderId: "42" }, context());
  expect(f.effects).toEqual(["reserve", "charge", "release"]);
  expect(f.authorizations.filter((value) => value === "actor:release")).toHaveLength(3);
});

test("thrown payment and compensation errors are not hidden, retried or called rollback", async () => {
  const unknown = fixture();
  unknown.setOutcome("throws");
  await expect(unknown.workflow.execute({ orderId: "42" }, context())).rejects.toThrow("outcome unknown");
  expect(unknown.effects).toEqual(["reserve", "charge"]);
  const compensation = fixture();
  compensation.setOutcome("declined");
  compensation.failRelease();
  await expect(compensation.workflow.execute({ orderId: "42" }, context())).rejects.toThrow("Release failed");
  expect(compensation.effects).toEqual(["reserve", "charge", "release"]);
});

test("unknown reserve, confirmation and compensation receipts cannot report completion", async () => {
  for (const step of ["reserve", "confirm", "release"] as const) {
    const f = fixture();
    if (step === "release") f.setOutcome("declined");
    f.pending(step);
    expect(await f.workflow.execute({ orderId: "42" }, context())).toEqual({
      status: "pending", step, operationId: "order-42",
    });
    await f.workflow.execute({ orderId: "42" }, context());
    expect(f.effects).toEqual(step === "reserve" ? ["reserve"] : ["reserve", "charge", step]);
  }
});
test("bindings do not capture identity from earlier calls", async () => {
  const f = fixture();
  await f.workflow.execute({ orderId: "42" }, context());
  await expect(f.workflow.execute({ orderId: "42" }, context("order-42", "other", false)))
    .rejects.toMatchObject({ code: "COMMAND_FORBIDDEN" });
  expect(f.effects).toEqual(["reserve", "charge", "confirm"]);
  expect(f.authorizations.at(-1)).toBe("other:reserve");
});
