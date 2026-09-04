import { describe, expect, it } from "bun:test";
import { RedirectCommand, executeRoutePipeline } from "./route_pipeline";
import type { RoutePipelineDefinition, RouterEvent } from "./route_pipeline";

describe("Angular Router lifecycle pipeline (executeRoutePipeline)", () => {
  it("executes handler successfully on happy path", async () => {
    const route: RoutePipelineDefinition = {
      path: "/items",
      method: "GET",
      handler: async (ctx) => ({ items: ["a", "b"], query: ctx.query }),
    };

    const result = await executeRoutePipeline(route, {
      url: "/items",
      method: "GET",
      query: { limit: 10 },
    });

    expect(result.matched).toBe(true);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ items: ["a", "b"], query: { limit: 10 } });
  });

  it("rejects route matching when CanMatch guard returns false", async () => {
    const route: RoutePipelineDefinition = {
      path: "/admin",
      method: "GET",
      handler: () => "admin data",
      canMatch: [() => false],
    };

    const result = await executeRoutePipeline(route, {
      url: "/admin",
      method: "GET",
    });

    expect(result.matched).toBe(false);
    expect(result.status).toBe(404);
    expect(result.error).toContain("CanMatch");
  });

  it("blocks activation when CanActivate guard returns false", async () => {
    const route: RoutePipelineDefinition = {
      path: "/protected",
      method: "GET",
      handler: () => "secret data",
      guards: [async (ctx) => ctx.headers?.authorization === "Bearer valid"],
    };

    const blockedResult = await executeRoutePipeline(route, {
      url: "/protected",
      method: "GET",
      headers: {},
    });
    expect(blockedResult.matched).toBe(true);
    expect(blockedResult.status).toBe(403);

    const allowedResult = await executeRoutePipeline(route, {
      url: "/protected",
      method: "GET",
      headers: { authorization: "Bearer valid" },
    });
    expect(allowedResult.matched).toBe(true);
    expect(allowedResult.status).toBe(200);
    expect(allowedResult.body).toBe("secret data");
  });

  it("prefetches data via resolvers before handler execution", async () => {
    const route: RoutePipelineDefinition = {
      path: "/users/:id",
      method: "GET",
      handler: (ctx) => ({ user: ctx.resolved?.user, extra: ctx.data?.user }),
      resolvers: {
        user: async (ctx) => ({ id: ctx.params?.id, name: `User ${ctx.params?.id}` }),
      },
    };

    const result = await executeRoutePipeline(route, {
      url: "/users/42",
      method: "GET",
      params: { id: "42" },
    });

    expect(result.status).toBe(200);
    expect(result.resolvedData).toEqual({ user: { id: "42", name: "User 42" } });
    expect(result.body).toEqual({
      user: { id: "42", name: "User 42" },
      extra: { id: "42", name: "User 42" },
    });
  });

  it("invokes controller instance method and evaluates CanDeactivate guard", async () => {
    class EditController {
      hasUnsavedChanges = true;
      async savePost(ctx: any) {
        return { saved: true, title: ctx.body?.title };
      }
    }

    const controller = new EditController();
    const route: RoutePipelineDefinition = {
      path: "/posts/1",
      method: "POST",
      handler: "savePost",
      canDeactivate: [
        (component: EditController) => !component.hasUnsavedChanges,
      ],
    };

    // Blocked by CanDeactivate because hasUnsavedChanges is true
    const blockedResult = await executeRoutePipeline(route, {
      url: "/posts/1",
      method: "POST",
      body: { title: "Draft" },
    }, controller);

    expect(blockedResult.status).toBe(409);
    expect(blockedResult.error).toContain("CanDeactivate");

    // Allowed once saved/clean
    controller.hasUnsavedChanges = false;
    const allowedResult = await executeRoutePipeline(route, {
      url: "/posts/1",
      method: "POST",
      body: { title: "Published" },
    }, controller);

    expect(allowedResult.status).toBe(200);
    expect(allowedResult.body).toEqual({ saved: true, title: "Published" });
  });

  it("catches handler errors and returns status 500", async () => {
    const route: RoutePipelineDefinition = {
      path: "/crash",
      method: "GET",
      handler: () => {
        throw new Error("Simulated backend failure");
      },
    };

    const result = await executeRoutePipeline(route, {
      url: "/crash",
      method: "GET",
    });

    expect(result.status).toBe(500);
    expect(result.error).toBe("Simulated backend failure");
  });

  it("emits Angular Router events throughout navigation lifecycle", async () => {
    const events: RouterEvent[] = [];
    const route: RoutePipelineDefinition = {
      path: "/items/:id",
      method: "GET",
      canMatch: [() => true],
      guards: [() => true],
      resolvers: {
        item: () => ({ id: "item-123" }),
      },
      handler: (ctx) => ({ success: true, item: ctx.resolved?.item }),
    };

    const result = await executeRoutePipeline(
      route,
      { url: "/items/item-123", method: "GET" },
      undefined,
      { onEvent: (e) => events.push(e) },
    );

    expect(result.status).toBe(200);
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toEqual([
      "NavigationStart",
      "RoutesRecognized",
      "GuardsCheckStart",
      "GuardsCheckEnd",
      "GuardsCheckStart",
      "GuardsCheckEnd",
      "ResolveStart",
      "ResolveEnd",
      "ExecutionStart",
      "ExecutionEnd",
      "NavigationEnd",
    ]);
  });

  it("supports Angular 18+ RedirectCommand from guard or handler", async () => {
    const guardedRoute: RoutePipelineDefinition = {
      path: "/admin",
      method: "GET",
      guards: [() => new RedirectCommand("/login", { status: 307 })],
      handler: () => ({ secret: "42" }),
    };

    const guardRedirect = await executeRoutePipeline(guardedRoute, { url: "/admin", method: "GET" });
    expect(guardRedirect.status).toBe(307);
    expect(guardRedirect.redirect).toBe("/login");
    expect(guardRedirect.headers?.Location).toBe("/login");

    const handlerRoute: RoutePipelineDefinition = {
      path: "/legacy",
      method: "GET",
      handler: () => new RedirectCommand("/modern"),
    };
    const handlerRedirect = await executeRoutePipeline(handlerRoute, { url: "/legacy", method: "GET" });
    expect(handlerRedirect.status).toBe(302);
    expect(handlerRedirect.redirect).toBe("/modern");
  });

  it("executes compiled route invoker when provided", async () => {
    const compiledRoute: RoutePipelineDefinition = {
      path: "/users/:id",
      method: "GET",
      handler: "getUser",
      invoker: (_ctrl, req) => ({ userId: Number(req.params?.id), queryPage: Number(req.query?.page ?? 1) }),
    };
    const result = await executeRoutePipeline(compiledRoute, { url: "/users/100", method: "GET", params: { id: "100" }, query: { page: "2" } });
    expect(result.body).toEqual({ userId: 100, queryPage: 2 });
  });
});
