import { describe, expect, it } from "bun:test";
import {
  PLATFORM_BROWSER_ID,
  PLATFORM_EDGE_ID,
  PLATFORM_ID,
  PLATFORM_SERVER_ID,
  detectPlatform,
  isPlatformBrowser,
  isPlatformEdge,
  isPlatformServer,
} from "./platform";
import { createEnvironmentInjector } from "./inject";

describe("Angular Universal PLATFORM_ID and platform detection", () => {
  it("detects current runtime platform in Bun/Node environment", () => {
    const current = detectPlatform();
    expect(current).toBe(PLATFORM_SERVER_ID);
    expect(isPlatformServer(current)).toBe(true);
    expect(isPlatformBrowser(current)).toBe(false);
    expect(isPlatformEdge(current)).toBe(false);
  });

  it("evaluates platform helper predicate functions correctly", () => {
    expect(isPlatformBrowser(PLATFORM_BROWSER_ID)).toBe(true);
    expect(isPlatformBrowser(PLATFORM_SERVER_ID)).toBe(false);

    expect(isPlatformServer(PLATFORM_SERVER_ID)).toBe(true);
    expect(isPlatformServer(PLATFORM_EDGE_ID)).toBe(true);
    expect(isPlatformServer(PLATFORM_BROWSER_ID)).toBe(false);

    expect(isPlatformEdge(PLATFORM_EDGE_ID)).toBe(true);
    expect(isPlatformEdge(PLATFORM_SERVER_ID)).toBe(false);
    expect(isPlatformEdge(PLATFORM_BROWSER_ID)).toBe(false);
  });

  it("injects PLATFORM_ID via EnvironmentInjector", () => {
    const env = createEnvironmentInjector([]);
    const platform = env.get(PLATFORM_ID);
    expect(platform).toBe(PLATFORM_SERVER_ID);
    expect(isPlatformServer(platform)).toBe(true);
  });
});
