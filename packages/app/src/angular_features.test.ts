import { describe, expect, it } from "bun:test";
import { DOCUMENT } from "./platform";
import { APP_BASE_HREF, ROUTER_CONFIGURATION, provideRouter, withComponentInputBinding, withRouterConfig, withTitleStrategy } from "./route_provider";
import { DefaultTitleStrategy, TITLE_STRATEGY, TitleStrategy } from "./title_strategy";
import { joinWithSlash, normalizePath, stripTrailingSlash } from "./location";
import { TestBed } from "./testing";
import { executeRoutePipeline } from "./route_pipeline";
import { createEnvironmentInjector, inject } from "./inject";

describe("Angular DX culminations in @supacloud/app", () => {
  it("resolves DOCUMENT token in environment injector", () => {
    const env = createEnvironmentInjector([]);
    const doc = env.runInContext(() => inject(DOCUMENT));
    // In bun test environment, document might be undefined or defined
    expect(doc === undefined || typeof doc === "object").toBe(true);
  });

  it("resolves APP_BASE_HREF with default '/' and allows overriding", () => {
    TestBed.configureTestingModule({});
    expect(TestBed.inject(APP_BASE_HREF)).toBe("/");

    TestBed.configureTestingModule({
      providers: [{ provide: APP_BASE_HREF, useValue: "/api/v1" }],
    });
    expect(TestBed.inject(APP_BASE_HREF)).toBe("/api/v1");
  });

  it("supports Location path normalization utilities", () => {
    expect(normalizePath("users/list")).toBe("/users/list");
    expect(normalizePath("//users///profile//")).toBe("/users/profile/");
    expect(stripTrailingSlash("/users/profile/")).toBe("/users/profile");
    expect(stripTrailingSlash("/")).toBe("/");
    expect(joinWithSlash("/api/v1/", "/users")).toBe("/api/v1/users");
    expect(joinWithSlash("api", "teams")).toBe("api/teams");
  });

  it("supports standalone provideRouter with router features", () => {
    const providers = provideRouter(
      [{ path: "/items", method: "GET", handler: "getItems" }],
      withComponentInputBinding(),
      withRouterConfig({ onSameUrlNavigation: "reload", paramsInheritanceStrategy: "always" }),
    );

    TestBed.configureTestingModule({
      providers: [providers],
    });

    const config = TestBed.inject(ROUTER_CONFIGURATION);
    expect(config.onSameUrlNavigation).toBe("reload");
    expect(config.paramsInheritanceStrategy).toBe("always");
  });

  it("executes TitleStrategy in executeRoutePipeline and updates context", async () => {
    class CustomTitleStrategy extends TitleStrategy {
      updateTitle(title: string | undefined, ctx?: any): void {
        if (ctx) {
          if (!ctx.data) ctx.data = {};
          ctx.data.title = this.buildTitle(title, "SupaCloud Enterprise");
        }
      }
    }

    const customStrategy = new CustomTitleStrategy();
    const ctx = { url: "/dashboard", method: "GET", data: {} as Record<string, unknown> };
    const result = await executeRoutePipeline(
      {
        path: "/dashboard",
        method: "GET",
        title: "Analytics Overview",
        handler: () => ({ ok: true }),
      },
      ctx,
      undefined,
      { titleStrategy: customStrategy },
    );

    expect(result.status).toBe(200);
    expect(ctx.data.title).toBe("SupaCloud Enterprise | Analytics Overview");
  });

  it("supports withTitleStrategy in provideRouter and TestBed", () => {
    class PrefixTitleStrategy extends TitleStrategy {
      updateTitle(title: string | undefined): void {
        // no-op
      }
    }

    const providers = provideRouter([], withTitleStrategy(PrefixTitleStrategy));
    TestBed.configureTestingModule({
      providers: [providers],
    });

    const strategy = TestBed.inject(TITLE_STRATEGY);
    expect(strategy instanceof PrefixTitleStrategy).toBe(true);
  });
});
