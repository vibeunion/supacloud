import { describe, expect, it, beforeEach } from "bun:test";
import { InjectionToken } from "./token";
import { TestBed } from "./testing";
import { INJECTOR, inject, injectAll } from "./inject";
import { provideRouter, ROUTE_CONFIG } from "./route_provider";

describe("Angular-style TestBed testing environment", () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it("resolves basic providers and classes", () => {
    const API_URL = new InjectionToken<string>("api.url");

    class GreeterService {
      greet(name: string): string {
        return `Hello, ${name}!`;
      }
    }

    TestBed.configureTestingModule({
      providers: [
        GreeterService,
        { provide: API_URL, useValue: "https://api.supacloud.dev" },
      ],
    });

    const greeter = TestBed.inject(GreeterService);
    const apiUrl = TestBed.inject(API_URL);

    expect(greeter).toBeInstanceOf(GreeterService);
    expect(greeter.greet("World")).toBe("Hello, World!");
    expect(apiUrl).toBe("https://api.supacloud.dev");
  });

  it("supports overriding providers with mocks", () => {
    const DATA_SERVICE = new InjectionToken<{ getData(): string }>("data.service");

    TestBed.configureTestingModule({
      providers: [
        {
          provide: DATA_SERVICE,
          useValue: { getData: () => "real data" },
        },
      ],
    });

    // Override with mock
    TestBed.overrideProvider(DATA_SERVICE, {
      provide: DATA_SERVICE,
      useValue: { getData: () => "mocked data" },
    });

    const service = TestBed.inject(DATA_SERVICE);
    expect(service.getData()).toBe("mocked data");
  });

  it("executes code within TestBed injection context via TestBed.run", () => {
    const TOKEN = new InjectionToken<number>("test.num");

    TestBed.configureTestingModule({
      providers: [{ provide: TOKEN, useValue: 42 }],
    });

    const result = TestBed.run(() => {
      return inject(TOKEN) * 2;
    });

    expect(result).toBe(84);
  });

  it("resolves multi-providers and injectAll", () => {
    const PLUGIN_TOKEN = new InjectionToken<string>("app.plugin");

    TestBed.configureTestingModule({
      providers: [
        { provide: PLUGIN_TOKEN, useValue: "plugin-a", multi: true },
        { provide: PLUGIN_TOKEN, useValue: "plugin-b", multi: true },
        { provide: PLUGIN_TOKEN, useFactory: () => "plugin-c", multi: true },
      ],
    });

    const plugins = TestBed.inject(PLUGIN_TOKEN) as unknown as string[];
    expect(plugins).toEqual(["plugin-a", "plugin-b", "plugin-c"]);

    const viaInjectAll = TestBed.run(() => injectAll(PLUGIN_TOKEN));
    expect(viaInjectAll).toEqual(["plugin-a", "plugin-b", "plugin-c"]);

    // Directly via TestBed.injectAll
    const directInjectAll = TestBed.injectAll(PLUGIN_TOKEN);
    expect(directInjectAll).toEqual(["plugin-a", "plugin-b", "plugin-c"]);

    // Resolving INJECTOR token from TestBed
    const testBedInjector = TestBed.inject(INJECTOR);
    expect(testBedInjector).toBeDefined();
  });

  it("supports provideRouter and ROUTE_CONFIG in TestBed", () => {
    const testRoutes = [
      { path: "/users", method: "GET", handler: "getUsers" },
      { path: "/users/:id", method: "GET", handler: "getUserById" },
    ];

    TestBed.configureTestingModule({
      providers: [provideRouter(testRoutes as any)],
    });

    const config = TestBed.inject(ROUTE_CONFIG);
    expect(config).toHaveLength(2);
    expect(config[0].path).toBe("/users");
  });

  it("throws clear error when provider is missing", () => {
    const MISSING = new InjectionToken<string>("missing.token");
    TestBed.configureTestingModule({});

    expect(() => TestBed.inject(MISSING)).toThrow("TestBed: No provider found");
  });
});
