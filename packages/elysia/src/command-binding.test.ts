import { expect, test } from "bun:test";
import {
  ApplicationError,
  bindCompiledCommand,
  createApplication,
  createWorker,
  executeCompiledCommand,
  requireIdempotencyKey,
  type CompiledCommandBindingOptions,
  type CompiledCommandCallContext,
  type CompiledModule,
  type ExecutionEvent,
  type WorkerClaim,
} from "./index";

function callContext(id = "call-1", allowed = true): CompiledCommandCallContext {
  return {
    request: new Request("https://app.example/approve", {
      method: "POST", headers: { "idempotency-key": id },
    }),
    requestContext: { requestId: id, allowed },
    services: { owner: id },
    scope: { owner: id },
  };
}

function decodeNumber(value: unknown): number {
  if (typeof value !== "number") throw new TypeError("Invalid command result");
  return value;
}

function definition(events: string[]): CompiledCommandBindingOptions<number, number> {
  return {
    module: {
      name: "approval",
      commands: [{
        name: "approval.accept", className: "Approve",
        permission: "approval.accept", transaction: "required", idempotency: "required", audit: "approved",
        aspects: [(_context, next) => { events.push("command-aspect"); return next(); }],
      }],
      aspects: [(_context, next) => { events.push("module-aspect"); return next(); }],
    },
    command: "Approve",
    governance: {
      authorize: (invocation) => {
        events.push("authorize");
        const identity = invocation.requestContext as { allowed: boolean };
        if (!identity.allowed) throw new ApplicationError("Denied", { status: 403, code: "COMMAND_FORBIDDEN" });
      },
      idempotency: (_invocation, next) => { events.push("idempotency"); return next(); },
      transaction: async (_invocation, next) => {
        events.push("transaction");
        const result = await next();
        events.push("commit");
        return result;
      },
      audit: {
        succeeded: () => { events.push("audit"); },
        failed: () => { events.push("audit-failed"); },
      },
    },
    handler: (input) => { events.push("handler"); return input + 1; },
    decode: decodeNumber,
  };
}

test("an explicit preview is callable without narrowing and never executes the command", async () => {
  const events: string[] = [];
  const bound = bindCompiledCommand({
    ...definition(events),
    preview: (input, context) => {
      expect(input).toBe(4);
      expect(context.services?.owner).toBe("call-1");
      return { command: "approval.accept", allowed: true, blockers: [] };
    },
  });
  await bound.preview(4, callContext());
  expect(events).toEqual(["authorize"]);
});

test("binding is inert and preserves the existing direct command execution order", async () => {
  const events: string[] = [];
  const options = definition(events);
  const bound = bindCompiledCommand(options);
  expect(events).toEqual([]);
  expect(Object.hasOwn(bound, "preview")).toBe(false);
  const context = callContext();
  expect(await bound.execute(4, context)).toBe(5);
  const boundEvents = [...events];
  events.length = 0;
  expect(await executeCompiledCommand({
    ...options, ...context, input: 4, handler: (input) => options.handler(input, context),
  })).toBe(5);
  expect(events).toEqual(boundEvents);
  expect(events).toEqual([
    "authorize", "idempotency", "transaction", "module-aspect",
    "command-aspect", "handler", "audit", "commit",
  ]);
});

test("every replay reauthorizes using the current host context", async () => {
  const events: string[] = [];
  const options = definition(events);
  const receipts = new Map<string, unknown>();
  options.governance = {
    ...options.governance,
    idempotency: async (invocation, next) => {
      const key = requireIdempotencyKey(invocation);
      if (receipts.has(key)) return receipts.get(key);
      const result = await next();
      receipts.set(key, result);
      return result;
    },
  };
  const bound = bindCompiledCommand(options);
  expect(await bound.execute(4, callContext("same-key"))).toBe(5);
  expect(await bound.execute(4, callContext("same-key"))).toBe(5);
  await expect(bound.execute(4, callContext("same-key", false)))
    .rejects.toMatchObject({ code: "COMMAND_FORBIDDEN" });
  expect(events.filter((event) => event === "authorize")).toHaveLength(3);
  expect(events.filter((event) => event === "handler")).toHaveLength(1);
  expect(events.filter((event) => event === "module-aspect")).toHaveLength(1);
});

test("concurrent calls keep request, identity, services and scopes local", async () => {
  const events: Readonly<ExecutionEvent>[] = [];
  const contexts = [callContext("first"), callContext("second")];
  const options = definition([]);
  let releaseFirst!: () => void;
  const firstWaiting = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const seen = new Map<number, CompiledCommandCallContext>();
  const bound = bindCompiledCommand({
    ...options,
    observer: (event) => { events.push(event); },
    governance: {
      ...options.governance,
      authorize: (invocation) => {
        const expected = contexts[decodeNumber(invocation.input.body) - 1]!;
        expect(invocation.request).toBe(expected.request);
        expect(invocation.requestContext).toBe(expected.requestContext);
        expect(expected.services).toBe(invocation.services);
        expect(invocation.scope).toBe(expected.scope);
        return options.governance.authorize(invocation);
      },
    },
    handler: async (input, context) => {
      if (input === 1) await firstWaiting;
      else releaseFirst();
      seen.set(input, context);
      return input;
    },
  });
  expect(await Promise.all(contexts.map((context, index) => bound.execute(index + 1, context)))).toEqual([1, 2]);
  expect(seen.get(1)).toBe(contexts[0]);
  expect(seen.get(2)).toBe(contexts[1]);
  expect(new Set(events.map((event) => event.requestId))).toEqual(new Set(["first", "second"]));
  expect(events.every((event) => !("requestContext" in event) && !("input" in event))).toBe(true);
});

test("duplicate continuations cannot cause a second write", async () => {
  let writes = 0;
  const options = definition([]);
  options.governance = {
    ...options.governance,
    transaction: async (_invocation, next) => {
      await next();
      return next();
    },
  };
  const bound = bindCompiledCommand({ ...options, handler: () => ++writes });
  await expect(bound.execute(4, callContext())).rejects.toMatchObject({ code: "COMMAND_CONTINUATION_REUSED" });
  expect(writes).toBe(1);
});

test("handler and audit failures propagate without retrying or hiding the error", async () => {
  const handlerError = new Error("handler failed");
  const auditError = new Error("audit failed");
  for (const failure of [handlerError, auditError]) {
    const events: string[] = [];
    const options = definition(events);
    let writes = 0;
    options.handler = () => {
      writes++;
      if (failure === handlerError) throw failure;
      return 5;
    };
    options.governance.audit!.succeeded = () => { throw auditError; };
    await expect(bindCompiledCommand(options).execute(4, callContext())).rejects.toBe(failure);
    expect(writes).toBe(1);
    expect(events).toContain("audit-failed");
    expect(events).not.toContain("commit");
  }
});

test("RPC results are decoded without invoking a second handler or local audit", async () => {
  const events: string[] = [];
  const options = definition(events);
  const command = options.module.commands![0]!;
  options.module = { ...options.module, commands: [{ ...command, rpc: "approve" }] };
  let result: unknown = 7;
  options.governance = {
    ...options.governance,
    rpc: {
      approve: {
        capabilities: { transaction: true, idempotency: true, audit: true },
        execute: () => { events.push("rpc"); return result; },
      },
    },
  };
  const bound = bindCompiledCommand(options);
  expect(await bound.execute(4, callContext())).toBe(7);
  result = { invalid: true };
  await expect(bound.execute(4, callContext())).rejects.toThrow("Invalid command result");
  expect(events).toEqual(["authorize", "rpc", "authorize", "rpc"]);
});

test("bound previews authorize but do not enter execution, aspects, RPC or audit", async () => {
  const events: string[] = [];
  const context = callContext();
  const bound = bindCompiledCommand({
    ...definition(events),
    preview: (input, received) => {
      expect(input).toBe(4);
      expect(received).toBe(context);
      events.push("preview");
      return { command: "approval.accept", allowed: true, blockers: [] };
    },
  });
  expect(bound.preview).toBeDefined();
  expect(await bound.preview(4, context)).toEqual({
    command: "approval.accept", allowed: true, blockers: [],
  });
  expect(await bound.preview(4, callContext("denied", false))).toMatchObject({
    allowed: false, blockers: [{ code: "COMMAND_FORBIDDEN", message: "Denied" }],
  });
  expect(events).toEqual(["authorize", "preview", "authorize"]);
});

test("bound calls retain missing descriptor and governance adapter failures", async () => {
  const events: string[] = [];
  const options = definition(events);
  await expect(bindCompiledCommand({ ...options, command: "Missing" }).execute(4, callContext()))
    .rejects.toMatchObject({ code: "COMMAND_NOT_REGISTERED" });
  await expect(bindCompiledCommand({
    ...options, module: { ...options.module, commands: [...options.module.commands!, ...options.module.commands!] },
  }).execute(4, callContext())).rejects.toMatchObject({ code: "COMMAND_NOT_REGISTERED" });
  await expect(bindCompiledCommand({
    ...options, governance: { authorize: options.governance.authorize },
  }).execute(4, callContext())).rejects.toMatchObject({ code: "COMMAND_AUDIT_UNAVAILABLE" });
  expect(events).toEqual([]);
});

test("HTTP and Worker entrypoints share one bound business command", async () => {
  const events: string[] = [];
  const bound = bindCompiledCommand(definition(events));
  const httpModule: CompiledModule = {
    name: "http-entry",
    createServices: () => ({
      controller: {
        approve: ({ body, request, requestContext }: { body: unknown; request: Request; requestContext: unknown }) =>
          bound.execute(decodeNumber(body), { request, requestContext }),
      },
    }),
    controllers: [{
      path: "/", serviceKey: "controller", scope: "application",
      routes: [{ method: "POST", path: "approve", handler: "approve" }],
    }],
  };
  const app = createApplication({
    modules: [httpModule],
    requestContext: () => ({ requestId: "http", allowed: true }),
  });
  const response = await app.handle(new Request("http://localhost/approve", {
    method: "POST", headers: { "content-type": "application/json" }, body: "4",
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toBe(5);
  const httpEvents = [...events];
  events.length = 0;
  const workerModule: CompiledModule = {
    name: "worker-entry", controllers: [],
    createServices: () => ({}),
    createJobScope: (_services, context) => ({
      job: { run: (input: unknown) => bound.execute(decodeNumber(input), {
        request: new Request("https://worker.example/approve"), requestContext: context,
      }) },
    }),
    jobs: [{ className: "ApproveJob", name: "approve-job", serviceKey: "job", scope: "job" }],
  };
  const worker = createWorker<WorkerClaim, unknown>({
    modules: [workerModule],
    requestContext: () => ({ requestId: "worker", allowed: true }),
    transport: {
      claim: async () => null,
      ack: (_claim, output) => output,
      fail: (_claim, error) => { throw error; },
    },
  });
  await worker.start();
  try {
    const result = await worker.processClaim({ id: "job-1", jobName: "approve-job", input: 4 });
    expect(result.status).toBe("acknowledged");
    expect(result.receipt).toBe(5);
    expect(events).toEqual(httpEvents);
  } finally {
    await worker.stop();
  }
});
