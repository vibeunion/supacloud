import { InjectionToken } from "./token";

export const PLATFORM_SERVER_ID = "server";
export const PLATFORM_BROWSER_ID = "browser";
export const PLATFORM_EDGE_ID = "edge";

export type PlatformId = "server" | "browser" | "edge";

/**
 * Detects the runtime execution platform.
 */
export function detectPlatform(): PlatformId {
  if (typeof window !== "undefined" && typeof (window as any).document !== "undefined") {
    return PLATFORM_BROWSER_ID;
  }
  if (typeof (globalThis as any).EdgeRuntime === "string") {
    return PLATFORM_EDGE_ID;
  }
  return PLATFORM_SERVER_ID;
}

/**
 * Built-in injection token for platform identification.
 * Modeled directly after Angular's PLATFORM_ID.
 */
export const PLATFORM_ID = new InjectionToken<string>("supacloud.platform-id", {
  scope: "application",
  factory: () => detectPlatform(),
});

/**
 * Returns whether a platform id represents a browser environment.
 * Modeled directly after Angular's isPlatformBrowser.
 */
export function isPlatformBrowser(platformId: unknown): boolean {
  return platformId === PLATFORM_BROWSER_ID;
}

/**
 * Returns whether a platform id represents a server-side environment (Node.js/Bun/Edge).
 * Modeled directly after Angular's isPlatformServer.
 */
export function isPlatformServer(platformId: unknown): boolean {
  return platformId === PLATFORM_SERVER_ID || platformId === PLATFORM_EDGE_ID;
}

/**
 * Returns whether a platform id represents an edge runtime environment.
 */
export function isPlatformEdge(platformId: unknown): boolean {
  return platformId === PLATFORM_EDGE_ID;
}
