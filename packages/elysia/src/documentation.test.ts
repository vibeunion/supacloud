import { describe, expect, test } from "bun:test";
import { createApplication, type CompiledModule } from "./index";
import { testRequest } from "./testing";

const emptyModule: CompiledModule = {
  name: "empty",
  createServices: () => ({}),
  controllers: [],
  commands: [],
};

describe("application documentation", () => {
  test("serves opt-in OpenAPI and GraphQL documentation", async () => {
    const app = createApplication({
      modules: [emptyModule],
      documentation: {
        openApi: {
          document: {
            openapi: "3.1.0",
            info: { title: "Orders", version: "1.0.0" },
            paths: {},
          },
        },
        graphql: {
          schema: "type Query { health: String! }",
        },
      },
    });

    const openApi = await testRequest(app, "/openapi.json");
    expect(openApi.status).toBe(200);
    expect(openApi.headers.get("content-type")).toContain("application/json");
    expect(await openApi.json()).toEqual({
      openapi: "3.1.0",
      info: { title: "Orders", version: "1.0.0" },
      paths: {},
    });

    const openApiPage = await testRequest(app, "/docs");
    expect(openApiPage.status).toBe(200);
    expect(await openApiPage.text()).toContain("/openapi.json");

    const schema = await testRequest(app, "/graphql/schema.graphql");
    expect(schema.status).toBe(200);
    expect(schema.headers.get("content-type")).toContain("text/plain");
    expect(await schema.text()).toBe("type Query { health: String! }");

    const graphqlPage = await testRequest(app, "/graphql/docs");
    expect(graphqlPage.status).toBe(200);
    expect(await graphqlPage.text()).toContain("/graphql/schema.graphql");
  });

  test("does not mount documentation unless configured", async () => {
    const app = createApplication({ modules: [emptyModule] });
    expect((await testRequest(app, "/openapi.json")).status).toBe(404);
    expect((await testRequest(app, "/graphql/schema.graphql")).status).toBe(404);
  });

  test("rejects duplicate documentation paths", () => {
    expect(() => createApplication({
      documentation: {
        openApi: { document: { openapi: "3.1.0", info: {}, paths: {} }, specPath: "/docs" },
      },
    })).toThrow("Duplicate documentation path");
  });
});
