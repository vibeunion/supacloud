/**
 * Reads the persisted Caddy JSON and checks whether a host is already
 * registered on any HTTP route. This backs the on-demand TLS ask endpoint:
 * if management-api has already published a route, Caddy should be allowed
 * to issue/load a certificate for that SNI.
 */
import { readFile } from "node:fs/promises";
import { config } from "../config";

type CaddyRoute = {
  match?: Array<{
    host?: unknown;
  }>;
  handle?: Array<{
    routes?: CaddyRoute[];
  }>;
};

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/:\d+$/, "");
}

function routeMatchesHost(route: CaddyRoute, domain: string): boolean {
  const matches = Array.isArray(route.match) ? route.match : [];
  for (const matcher of matches) {
    const hosts = Array.isArray(matcher.host) ? matcher.host : [];
    if (hosts.some((host) => typeof host === "string" && normalizeHost(host) === domain)) {
      return true;
    }
  }

  const handlers = Array.isArray(route.handle) ? route.handle : [];
  return handlers.some((handler) =>
    Array.isArray(handler.routes) && handler.routes.some((child) => routeMatchesHost(child, domain)),
  );
}

export async function isCaddyRouteDomain(domain: string, caddyConfigPath = config.caddyConfigPath): Promise<boolean> {
  const normalizedDomain = normalizeHost(domain);
  if (!normalizedDomain) return false;

  try {
    const raw = await readFile(caddyConfigPath, "utf8");
    const parsed = JSON.parse(raw) as {
      apps?: {
        http?: {
          servers?: Record<string, { routes?: CaddyRoute[] }>;
        };
      };
    };
    const servers = parsed.apps?.http?.servers || {};
    return Object.values(servers).some((server) =>
      (server.routes || []).some((route) => routeMatchesHost(route, normalizedDomain)),
    );
  } catch {
    return false;
  }
}
