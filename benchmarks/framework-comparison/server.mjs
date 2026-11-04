import "reflect-metadata";

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
const BODY_RESPONSE = Object.freeze({ ok: true, value: 42, label: "benchmark" });
const packageVersions = {
  ...(adapter === "elysia-native-bare-bun" || adapter === "elysia-native-contract-bun" || adapter === "supacloud-elysia-bun" ? { elysia: "2.0.0-rc.0" } : {}),
  ...(adapter === "supacloud-elysia-bun" || adapter === "supacloud-bun-native" ? { supacloudCore: process.env.SUPACLOUD_CORE_VERSION ?? "source-at-release-tag" } : {}),
  ...(adapter === "express" || adapter === "nestjs-express" ? { express: "5.3.0" } : {}),
  ...(adapter === "fastify" ? { fastify: "5.12.8" } : {}),
  ...(adapter.startsWith("nestjs-")
    ? { nest: "12.3.2", nestAdapter: adapter === "nestjs-node" ? "@nestjs/platform-node" : "@nestjs/platform-express" }
    : {}),
};

function methodDecorator(decorator, target, key) {
  decorator(target, key, Object.getOwnPropertyDescriptor(target, key));
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function isFunction(value) {
  return typeof value === "function";
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
  const app = Fastify({ logger: false });
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

async function startElysia() {
  if (typeof Bun === "undefined") {
    throw new Error("elysia-bun must be started by Bun");
  }
  const { Elysia } = await import("elysia");
  const app = new Elysia()
    .get("/json", () => STATIC_RESPONSE)
    .get("/params/:id", ({ params }) => ({ ok: true, id: params.id }))
    .post("/echo", ({ body }) => ({ ...body, ok: true }));
  const server = Bun.serve({ hostname: HOST, port, fetch: app.fetch });
  return { runtime: `bun ${Bun.version}`, close: () => server.stop(true) };
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
  const [{ Elysia, t }, { createApplication }] = await Promise.all([
    import("elysia"),
    import("@supacloud/elysia"),
  ]);
  // Keep this descriptor in the same shape as compiler output. Generated routes
  // carry a positional invoker which calls the controller method with decoded
  // parameters.
  const routes = [
    {
      method: "GET",
      path: "/json",
      handler: "json",
      invoker: async (controller, request) => {
        if (!isRecord(controller)) throw new TypeError("Route controller is not an object");
        const handler = controller["json"];
        if (!isFunction(handler)) throw new TypeError("Route handler json is not callable");
        return await Reflect.apply(handler, controller, [request]);
      },
    },
    {
      method: "GET",
      path: "/params/:id",
      handler: "params",
      params: t.Object({ id: t.String() }),
      invoker: async (controller, request) => {
        if (!isRecord(controller)) throw new TypeError("Route controller is not an object");
        const handler = controller["params"];
        if (!isFunction(handler)) throw new TypeError("Route handler params is not callable");
        return await Reflect.apply(handler, controller, [request.params?.["id"]]);
      },
    },
    {
      method: "POST",
      path: "/echo",
      handler: "echo",
      body: t.Object({ value: t.Number(), label: t.String() }),
      invoker: async (controller, request) => {
        if (!isRecord(controller)) throw new TypeError("Route controller is not an object");
        const handler = controller["echo"];
        if (!isFunction(handler)) throw new TypeError("Route handler echo is not callable");
        return await Reflect.apply(handler, controller, [request.body]);
      },
    },
  ];
  const controller = {
    json: () => STATIC_RESPONSE,
    params: (id) => ({ ok: true, id }),
    echo: (body) => ({ ...body, ok: true }),
  };
  const module = {
    name: "framework-comparison",
    createServices: () => ({ controller }),
    controllers: [{
      path: "",
      serviceKey: "controller",
      scope: "application",
      routes,
    }],
  };
  const app = new Elysia().use(createApplication({
    modules: [module],
  }));
  const server = Bun.serve({ hostname: HOST, port, fetch: app.fetch });
  return { runtime: `bun ${Bun.version}`, close: () => server.stop(true) };
}

async function startSupaCloudBunNative() {
  if (typeof Bun === "undefined") throw new Error("supacloud-bun-native must be started by Bun");
  const [{ Type }, { createBunNativeApplication }] = await Promise.all([
    import("typebox"),
    import("@supacloud/elysia/bun"),
  ]);
  const routes = [
    {
      method: "GET", path: "/json", handler: "json",
      invoker: async (controller) => controller.json(),
    },
    {
      method: "GET", path: "/params/:id", handler: "params", params: Type.Object({ id: Type.String() }),
      invoker: async (controller, request) => controller.params(request.params?.id),
    },
    {
      method: "POST", path: "/echo", handler: "echo", body: Type.Object({ value: Type.Number(), label: Type.String() }),
      invoker: async (controller, request) => controller.echo(request.body),
    },
  ];
  const app = createBunNativeApplication({
    modules: [{
      name: "framework-comparison-native",
      createServices: () => ({
        controller: {
          json: () => STATIC_RESPONSE,
          params: (id) => ({ ok: true, id }),
          echo: (body) => ({ ...body, ok: true }),
        },
      }),
      controllers: [{ path: "", serviceKey: "controller", scope: "application", routes }],
    }],
  });
  const server = app.start({ hostname: HOST, port });
  return { runtime: `bun ${Bun.version}`, close: () => server.stop(true) };
}

const starters = {
  express: startExpress,
  fastify: startFastify,
  "nestjs-express": () => startNest("express"),
  "nestjs-node": () => startNest("node"),
  "elysia-native-bare-bun": startElysia,
  "elysia-native-contract-bun": startElysiaContract,
  "supacloud-elysia-bun": startSupaCloudElysia,
  "supacloud-bun-native": startSupaCloudBunNative,
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
