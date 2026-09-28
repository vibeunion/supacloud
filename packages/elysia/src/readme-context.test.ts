import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Elysia, t } from "elysia";
import { createApplication, type CompiledModule } from "./index";

function createReadmeApp(compiledModules: CompiledModule[]) {
  // README-EXAMPLE:start
  const http = new Elysia({ name: "application-context" })
    .decorate("clock", { now: () => Date.now() })
    .guard({ query: t.Object({ locale: t.Optional(t.String()) }) })
    .derive(({ clock, query }) => ({
      startedAt: clock.now(),
      locale: query.locale ?? "en",
    }))
    .as("plugin");

  const app = createApplication({
    http,
    modules: compiledModules,
    requestContext: (request, context) => ({
      request,
      startedAt: context.startedAt,
      locale: context.locale,
    }),
  }).get("/locale", ({ locale, clock }) => ({
    locale,
    now: clock.now(),
  }));
  // README-EXAMPLE:end
  return app;
}

test("README context example stays identical to the typechecked executable example", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const section = readme.split("## Native HTTP Context And Static DI\n")[1];
  const documented = section?.match(/```ts\n([\s\S]*?)```/)?.[1]?.trim();
  const source = readFileSync(new URL(import.meta.url), "utf8");
  const marker = "  // README-EXAMPLE";
  const example = source.split(`${marker}:start\n`)[1]?.split(`${marker}:end`)[0]
    ?.replace(/^ {2}/gm, "").trim();
  expect(example).toBeDefined();
  expect(documented).toBe([
    'import { Elysia, t } from "elysia";',
    'import { createApplication } from "@supacloud/elysia";',
    "", example,
  ].join("\n"));
});

test("README native route retains the derived locale and decorated clock", async () => {
  const app = createReadmeApp([]);
  for (const [query, locale] of [["", "en"], ["?locale=ja", "ja"]]) {
    const response = await app.handle(new Request(`http://localhost/locale${query}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ locale, now: expect.any(Number) });
  }
});

test("README context reaches compiled request-scoped controllers", async () => {
  const compiled: CompiledModule = {
    name: "readme-context",
    createServices: () => ({}),
    createRequestScope: (_services, context) => ({ controller: { run: () => context } }),
    controllers: [{
      path: "/compiled", serviceKey: "controller", scope: "request",
      routes: [{ method: "GET", path: "", handler: "run" }],
    }],
  };
  const response = await createReadmeApp([compiled])
    .handle(new Request("http://localhost/compiled?locale=ja"));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ locale: "ja", startedAt: expect.any(Number) });
});
