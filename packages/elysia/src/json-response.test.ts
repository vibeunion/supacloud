import { expect, test } from "bun:test";
import Elysia, { t } from "elysia";
import {
  ApplicationError,
  createApplication,
  createModulePlugin,
  validatedJsonResponse,
  type CompiledModule,
} from "./index";

interface Receipt {
  id: string;
}

function isReceipt(value: unknown): value is Receipt {
  return typeof value === "object" && value !== null
    && "id" in value && typeof value.id === "string";
}

function receiptModule(write: () => unknown): CompiledModule {
  return {
    name: "receipt",
    createServices: () => ({ controller: { write } }),
    controllers: [{
      path: "/receipt",
      serviceKey: "controller",
      scope: "application",
      routes: [{
        method: "POST",
        path: "",
        handler: "write",
        response: t.Object({ id: t.String() }),
        command: "WriteCommand",
      }],
    }],
    commands: [{ className: "WriteCommand", name: "receipt.write" }],
  };
}

test("validated JSON preserves payload, status and headers without mutating options", async () => {
  const payload = { id: "receipt-1", compatibleField: "preserved" };
  const headers = new Headers({ "x-receipt": "receipt-1" });
  const response = validatedJsonResponse(isReceipt, payload, {
    status: 201, statusText: "Created", headers,
  });

  expect(response.status).toBe(201);
  expect(response.statusText).toBe("Created");
  expect(response.headers.get("x-receipt")).toBe("receipt-1");
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(headers.has("content-type")).toBe(false);
  expect(await response.json()).toEqual(payload);
});

test("validated JSON preserves an explicitly supplied content type", async () => {
  const response = validatedJsonResponse(isReceipt, { id: "receipt-1" }, {
    headers: { "content-type": "application/vnd.example.receipt+json" },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/vnd.example.receipt+json");
  expect(await response.json()).toEqual({ id: "receipt-1" });
});

test("validated JSON supports primitive JSON values and null", async () => {
  const isNullableString = (value: unknown): value is string | null => (
    value === null || typeof value === "string"
  );
  for (const value of [null, "receipt-1"]) {
    expect(await validatedJsonResponse(isNullableString, value).json()).toBe(value);
  }
});

test("invalid and null-body statuses reject a JSON body", () => {
  for (const status of [99, 204, 205, 304, 600]) {
    expect(() => validatedJsonResponse(isReceipt, { id: "receipt-1" }, { status }))
      .toThrow();
  }
});

test("validators must return literal true even when runtime callers bypass types", () => {
  for (const result of [undefined, "true", 1, Promise.resolve(true)]) {
    const invalidGuard = (() => result) as unknown as typeof isReceipt;
    expect(() => validatedJsonResponse(invalidGuard, { id: "receipt-1" }))
      .toThrow(ApplicationError);
  }
});

test("validation examines the serialized snapshot and serializes only once", async () => {
  let serializations = 0;
  let validations = 0;
  const payload = {
    id: "original",
    toJSON() {
      serializations++;
      return { id: "wire-value" };
    },
  };
  const response = validatedJsonResponse((value): value is Receipt => {
    validations++;
    expect(value).toEqual({ id: "wire-value" });
    return isReceipt(value);
  }, payload);

  expect(serializations).toBe(1);
  expect(validations).toBe(1);
  expect(await response.json()).toEqual({ id: "wire-value" });
});

test("JSON transformations cannot silently bypass the receipt validator", () => {
  const payload = {
    id: "original",
    toJSON: () => ({ id: 42 }),
  };
  expect(() => validatedJsonResponse(isReceipt, payload)).toThrow(ApplicationError);
});

test("serialization and validator errors are sanitized without causes or payloads", () => {
  const cyclic: Receipt & { self?: unknown } = { id: "private receipt" };
  cyclic.self = cyclic;
  const invalidValues: unknown[] = [
    undefined, { id: 42 }, { id: 1n }, cyclic,
    { id: "private receipt", toJSON() { throw new Error("private serialization details"); } },
  ];
  for (const value of invalidValues) {
    let error: unknown;
    try {
      validatedJsonResponse(isReceipt, value as Receipt);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(ApplicationError);
    expect(error).toMatchObject({
      status: 500, code: "RESPONSE_VALIDATION_ERROR", message: "Response validation failed",
    });
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain("private");
  }

  const throwingValidator = (_value: unknown): _value is Receipt => {
    throw new Error("private validator details");
  };
  expect(() => validatedJsonResponse(throwingValidator, { id: "private receipt" }))
    .toThrow("Response validation failed");
});

test("invalid receipt after a write returns 500 and never replays the command", async () => {
  let writes = 0;
  const app = createApplication({
    modules: [receiptModule(() => {
      writes++;
      return validatedJsonResponse(isReceipt, { id: 42 } as unknown as Receipt);
    })],
    commandExecutor: (_invocation, next) => next(),
  });
  const response = await app.handle(new Request("http://localhost/receipt", { method: "POST" }));

  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    ok: false, code: "RESPONSE_VALIDATION_ERROR", message: "Response validation failed",
  });
  expect(writes).toBe(1);
});

test("custom error mapping keeps request context and can require outcome confirmation", async () => {
  let observed: unknown;
  const app = createApplication({
    modules: [receiptModule(() => validatedJsonResponse(isReceipt, {} as Receipt))],
    commandExecutor: (_invocation, next) => next(),
    requestContext: () => ({ requestId: "request-1" }),
    errorMapper: (error, context) => {
      observed = { error, context };
      return Response.json({ code: "OUTCOME_UNKNOWN" }, { status: 503 });
    },
  });
  const response = await app.handle(new Request("http://localhost/receipt", { method: "POST" }));

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ code: "OUTCOME_UNKNOWN" });
  expect(observed).toMatchObject({
    error: { code: "RESPONSE_VALIDATION_ERROR", status: 500 },
    context: { requestContext: { requestId: "request-1" } },
  });
});

test("standalone plugins map explicit response contract errors to server failures", async () => {
  const compiled = receiptModule(() => validatedJsonResponse(isReceipt, {} as Receipt));
  const app = new Elysia().use(createModulePlugin(
    compiled, compiled.createServices({}, {}), undefined, {
      commandExecutor: (_invocation, next) => next(),
    },
  ));
  const response = await app.handle(new Request("http://localhost/receipt", { method: "POST" }));

  expect(response.status).toBe(500);
  expect((await response.json()).code).toBe("RESPONSE_VALIDATION_ERROR");
});

test("binary and streaming native responses still bypass JSON validation", async () => {
  const bytes = new Uint8Array([0, 255, 1, 128]);
  for (const body of [
    bytes,
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  ]) {
    const app = createApplication({
      modules: [receiptModule(() => new Response(body, {
        status: 202, headers: { "content-type": "application/octet-stream" },
      }))],
      commandExecutor: (_invocation, next) => next(),
    });
    const response = await app.handle(new Request("http://localhost/receipt", { method: "POST" }));

    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  }
});

// These calls are checked by typecheck:test and are never executed.
function checkResponseTypes() {
  validatedJsonResponse(isReceipt, { id: "receipt-1" });
  // @ts-expect-error Input must match the type inferred from the validator.
  validatedJsonResponse(isReceipt, { id: 42 });
  // @ts-expect-error Async validators cannot establish a synchronous contract.
  validatedJsonResponse(async () => true, { id: "receipt-1" });
}
