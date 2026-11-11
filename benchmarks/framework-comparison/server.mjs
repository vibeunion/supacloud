import "reflect-metadata";
import { readFile } from "node:fs/promises";

const HOST = "127.0.0.1";
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const adapter = args.get("--adapter");
const port = Number(args.get("--port"));
if (!adapter || !Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("Usage: server.mjs --adapter <name> --port <port>");
}

const STATIC_RESPONSE = Object.freeze({ ok: true, value: 42 });
const packageVersions = {
  ...(adapter === "elysia-native-contract-bun" || adapter === "supacloud-elysia-bun" ? { elysia: "2.0.0-rc.1" } : {}),
  ...(adapter === "supacloud-elysia-bun" ? { supacloudCore: process.env.SUPACLOUD_CORE_VERSION ?? JSON.parse(await readFile(new URL("../../packages/elysia/package.json", import.meta.url), "utf8")).version } : {}),
  ...(adapter === "express" || adapter === "nestjs-express" ? { express: "5.3.0" } : {}),
  ...(adapter === "fastify" ? { fastify: "5.12.8" } : {}),
  ...(adapter.startsWith("nestjs-")
    ? { nest: "12.3.2", nestAdapter: adapter === "nestjs-node" ? "@nestjs/platform-node" : "@nestjs/platform-express" }
    : {}),
};

function methodDecorator(decorator, target, key) {
  decorator(target, key, Object.getOwnPropertyDescriptor(target, key));
}

function makeContracts(Type) {
  return {
    params: Type.Object({ id: Type.String() }),
    body: Type.Object({ value: Type.Number(), label: Type.String() }),
  };
}

function makeNestModule(common, contracts, Type, Value) {
  const { BadRequestException, Body, Controller, Get, HttpCode, Module, Param, Post } = common;
  class TypeBoxPipe {
    constructor(schema) {
      this.schema = schema;
    }

    transform(value) {
      if (!Value.Check(this.schema, value)) throw new BadRequestException("Validation failed");
      return value;
    }
  }
  class BenchmarkController {
    json() {
      return STATIC_RESPONSE;
    }

    params(id) {
      return { ok: true, id };
    }

    echo(body) {
      return { ...body, ok: true };
    }
  }
  Controller()(BenchmarkController);
  methodDecorator(Get("/json"), BenchmarkController.prototype, "json");
  methodDecorator(Get("/params/:id"), BenchmarkController.prototype, "params");
  methodDecorator(Post("/echo"), BenchmarkController.prototype, "echo");
  methodDecorator(HttpCode(200), BenchmarkController.prototype, "echo");
  Param("id", new TypeBoxPipe(Type.String()))(BenchmarkController.prototype, "params", 0);
  Body(new TypeBoxPipe(contracts.body))(BenchmarkController.prototype, "echo", 0);

  class BenchmarkModule {}
  Module({ controllers: [BenchmarkController] })(BenchmarkModule);
  return BenchmarkModule;
}

async function startExpress() {
  const [{ default: express }, { Type }, { Value }] = await Promise.all([
    import("express"),
    import("typebox"),
    import("typebox/value"),
  ]);
  const contracts = makeContracts(Type);
  const app = express();
  app.use(express.json());
  app.get("/json", (_request, response) => response.json(STATIC_RESPONSE));
  app.get("/params/:id", (request, response, next) => {
    if (!Value.Check(contracts.params, request.params)) return response.status(422).json({ error: "Validation failed" });
    return next();
  }, (request, response) => response.json({ ok: true, id: request.params.id }));
  app.post("/echo", (request, response, next) => {
    if (!Value.Check(contracts.body, request.body)) return response.status(422).json({ error: "Validation failed" });
    return next();
  }, (request, response) => response.json({ ...request.body, ok: true }));
  const server = await new Promise((resolve, reject) => {
    const value = app.listen(port, HOST, () => resolve(value));
    value.once("error", reject);
  });
  return {
    runtime: `node ${process.versions.node}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function startFastify() {
  const [{ default: Fastify }, { Type }] = await Promise.all([import("fastify"), import("typebox")]);
  const contracts = makeContracts(Type);
  const app = Fastify({ logger: false, ajv: { customOptions: { coerceTypes: false } } });
  app.get("/json", async () => STATIC_RESPONSE);
  app.get("/params/:id", { schema: { params: contracts.params } }, async (request) => ({ ok: true, id: request.params.id }));
  app.post("/echo", { schema: { body: contracts.body } }, async (request) => ({ ...request.body, ok: true }));
  await app.listen({ port, host: HOST });
  return { runtime: `node ${process.versions.node}`, close: () => app.close() };
}

async function startNest(platform) {
  const [{ NestFactory }, common, { Type }, { Value }] = await Promise.all([
    import("@nestjs/core"),
    import("@nestjs/common"),
    import("typebox"),
    import("typebox/value"),
  ]);
  const moduleClass = makeNestModule(common, makeContracts(Type), Type, Value);
  const adapter = platform === "express"
    ? new (await import("@nestjs/platform-express")).ExpressAdapter()
    : new (await import("@nestjs/platform-node")).NodeAdapter();
  const app = await NestFactory.create(moduleClass, adapter, { logger: false });
  await app.listen(port, HOST);
  return {
    runtime: `node ${process.versions.node}`,
    close: () => app.close(),
  };
}

async function startElysiaContract() {
  if (typeof Bun === "undefined") {
    throw new Error("elysia-native-contract-bun must be started by Bun");
  }
  const { Elysia, t } = await import("elysia");
  const app = new Elysia()
    .get("/json", () => STATIC_RESPONSE)
    .get("/params/:id", { params: t.Object({ id: t.String() }) }, ({ params }) => ({ ok: true, id: params.id }))
    .post("/echo", { body: t.Object({ value: t.Number(), label: t.String() }) }, ({ body }) => ({ ...body, ok: true }));
  const server = Bun.serve({ hostname: HOST, port, fetch: app.fetch });
  return { runtime: `bun ${Bun.version}`, close: () => server.stop(true) };
}

async function startSupaCloudElysia() {
  if (typeof Bun === "undefined") {
    throw new Error("supacloud-elysia-bun must be started by Bun");
  }
  const [{ createApplication }, { createCompiledModules }] = await Promise.all([
    import("@supacloud/elysia"), import("./generated/application.ts"),
  ]);
  const app = createApplication({ modules: createCompiledModules() });
  const server = Bun.serve({ hostname: HOST, port, fetch: app.fetch });
  return { runtime: `bun ${Bun.version}`, close: () => server.stop(true) };
}

const starters = {
  express: startExpress,
  fastify: startFastify,
  "nestjs-express": () => startNest("express"),
  "nestjs-node": () => startNest("node"),
  "elysia-native-contract-bun": startElysiaContract,
  "supacloud-elysia-bun": startSupaCloudElysia,
};
const start = starters[adapter];
if (!start) throw new Error(`Unknown adapter: ${adapter}`);

const server = await start();
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    await server.close();
  } finally {
    process.exit(0);
  }
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
  console.log(JSON.stringify({ event: "ready", adapter, runtime: server.runtime, packageVersions }));
