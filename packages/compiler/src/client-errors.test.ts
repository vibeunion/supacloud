import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { renderClient } from "./generate";
import { writeFixtureProject } from "./fixtures/helpers";
import type { ApplicationGraph } from "./types";

const graph: ApplicationGraph = {
  externalTokens: [], modules: [{
    name: "orders", className: "OrdersModule", file: "orders.ts", line: 1,
    imports: [], providers: [], commands: [], queries: [], exports: [],
    controllers: [{
      className: "OrdersController", path: "/orders/:id", scope: "application",
      deps: [], file: "orders.ts", importPath: "./orders",
      schemaImports: { Result: "./contracts", Rejection: "./contracts" },
      routes: [
        { method: "POST", path: "/pay", handler: "pay", responses: { 200: "Result", 409: "Rejection" } },
        { method: "GET", path: "/raw", handler: "raw" },
      ],
    }],
  }],
};

async function fixture(run: (generated: Awaited<ReturnType<typeof loadClient>>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "supacloud-client-errors-"));
  try {
    await writeFixtureProject(root, {
      "client.ts": renderClient(graph, { rootDir: root, outDir: root }),
      "contracts.ts": [
        'export const Result = { type: "object", properties: { paid: { type: "boolean" } }, required: ["paid"] };',
        'export const Rejection = { type: "object", properties: { declined: { type: "boolean" } }, required: ["declined"] };',
      ].join("\n"),
    });
    await run(await loadClient(join(root, "client.ts")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function loadClient(path: string) {
  return import(pathToFileURL(path).href);
}

test("HTTP errors have stable metadata, omit sensitive bodies and do not resend", () => fixture(async (generated) => {
  let sends = 0;
  const client = generated.createApiClient({
    baseUrl: "https://private.example",
    fetch: async () => {
      sends++;
      return new Response("private backend credentials", { status: 503, headers: { "x-request-id": "trace-42" } });
    },
  });
  try {
    await client.orders.pay({ params: { id: "private-id" }, query: { secret: "private-query" } });
    throw new Error("Expected a failure");
  } catch (error) {
    expect(error).toBeInstanceOf(generated.ApiClientError);
    expect(error).toMatchObject({
      name: "ApiClientError", code: "API_HTTP_ERROR", method: "POST",
      path: "/orders/:id/pay", status: 503, requestId: "trace-42",
    });
    expect(String(error)).not.toContain("private");
    expect(JSON.stringify(error)).not.toContain("private");
    expect(error).not.toHaveProperty("cause");
    expect(error !== null && typeof error === "object" && "response" in error).toBe(true);
    if (error !== null && typeof error === "object" && "response" in error && error.response instanceof Response) {
      expect(await error.response.text()).toBe("private backend credentials");
      expect(Object.keys(error)).not.toContain("response");
    }
  }
  expect(sends).toBe(1);
}));

test("contract and malformed JSON errors are distinguishable from HTTP failures", () => fixture(async (generated) => {
  for (const response of [
    Response.json({ paid: "invalid" }),
    new Response('{"private":', { headers: { "content-type": "application/json" } }),
    Response.json({ paid: true }, { status: 201 }),
  ]) {
    let sends = 0;
    const client = generated.createApiClient({ fetch: async () => { sends++; return response; } });
    await expect(client.orders.pay({ params: { id: 1 } })).rejects.toMatchObject({
      code: response.status === 201 ? "API_RESPONSE_UNDECLARED" : "API_RESPONSE_INVALID",
      status: response.status, method: "POST", path: "/orders/:id/pay",
    });
    expect(sends).toBe(1);
  }
}));

test("declared errors stay typed values, decoder errors and transport failures retain ownership", () => fixture(async (generated) => {
  const domain = generated.createApiClient({
    fetch: async () => Response.json({ declined: true }, { status: 409 }),
  });
  expect(await domain.orders.pay({ params: { id: 1 } })).toEqual({ declined: true });
  const customFailure = new Error("application decoder");
  await expect(domain.orders.pay({ params: { id: 1 } }, () => { throw customFailure; })).rejects.toBe(customFailure);
  const transportFailure = new TypeError("offline");
  let sends = 0;
  const offline = generated.createApiClient({ fetch: async () => { sends++; throw transportFailure; } });
  await expect(offline.orders.pay({ params: { id: 1 } })).rejects.toBe(transportFailure);
  expect(sends).toBe(1);
  const raw = generated.createApiClient({ fetch: async () => Response.json({ arbitrary: "value" }) });
  expect(await raw.orders.raw({ params: { id: 1 } })).toEqual({ arbitrary: "value" });
}));

test("JSON response body transport failures retain the original error, even a SyntaxError", () => fixture(async (generated) => {
  for (const failure of [new TypeError("socket closed after headers"), new SyntaxError("stream decoding failed")]) {
    let sends = 0;
    const client = generated.createApiClient({
      fetch: async () => {
        sends++;
        return new Response(new ReadableStream({
          start(controller) { controller.error(failure); },
        }), { headers: { "content-type": "application/json" } });
      },
    });
    await expect(client.orders.pay({ params: { id: 1 } })).rejects.toBe(failure);
    expect(sends).toBe(1);
  }
}));

test("schemas named after client error exports are aliased without changing their contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-client-error-names-"));
  try {
    const names = ["ApiClientError", "ApiClientErrorCode", "ApiClientErrorDetails"];
    const controller = graph.modules[0]!.controllers[0]!;
    const collisionGraph: ApplicationGraph = {
      ...graph, modules: [{ ...graph.modules[0]!, controllers: [{
        ...controller,
        schemaImports: Object.fromEntries(names.map((name) => [name, "./contracts"])),
        routes: names.map((name) => ({
          method: "GET", path: `/${name}`, handler: name, responses: { 200: name },
        })),
      }] }],
    };
    const source = renderClient(collisionGraph, { rootDir: root, outDir: root });
    await writeFixtureProject(root, {
      "client.ts": source,
      "contracts.ts": names.map((name) =>
        `export const ${name} = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };`).join("\n"),
    });
    for (const name of names) expect(source).toContain(`${name} as ${name}2`);
    const generated = await loadClient(join(root, "client.ts"));
    const client = generated.createApiClient({ fetch: async () => Response.json({ id: "ok" }) });
    for (const name of names) expect(await client.orders[name]({ params: { id: 1 } })).toEqual({ id: "ok" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("untrusted trace headers are bounded and schema-free clients export the same errors", () => fixture(async (generated) => {
  const details = { code: "API_HTTP_ERROR", method: "GET", path: "/orders", status: 500 };
  const error = new generated.ApiClientError("Failed", { ...details, requestId: "x".repeat(257) });
  expect(error.requestId).toBeUndefined();
  expect(new generated.ApiClientError("Failed", { ...details, requestId: "invalid space" }).requestId)
    .toBeUndefined();
  const root = await mkdtemp(join(tmpdir(), "supacloud-schema-free-client-"));
  try {
    const controller = graph.modules[0]!.controllers[0]!;
    const schemaFree: ApplicationGraph = {
      ...graph, modules: [{ ...graph.modules[0]!, controllers: [{
        ...controller, routes: [{ method: "GET", path: "/raw", handler: "raw" }],
      }] }],
    };
    await writeFixtureProject(root, { "client.ts": renderClient(schemaFree) });
    const empty = await loadClient(join(root, "client.ts"));
    const client = empty.createApiClient({ fetch: async () => new Response(null, { status: 404 }) });
    await expect(client.orders.raw({ params: { id: 1 } })).rejects.toBeInstanceOf(empty.ApiClientError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}));
