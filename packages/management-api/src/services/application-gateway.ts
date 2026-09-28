import { stableSha256, stableStringify } from "../utils/stable-json";
import { applicationRuntimePlan, type ApplicationRuntimeInput } from "./application-runtime";
import { makeReverseProxy, type CaddyRoute } from "./gateway-route-builders";

export const APPLICATION_ROUTE_PREFIX = "route-application-";

export interface ApplicationGatewayInput {
  runtime: ApplicationRuntimeInput;
  hosts: Readonly<Record<string, readonly string[]>>;
}

export function applicationGatewayProjectRef(id: string): string | null {
  return /^route-application-([a-z0-9-]{1,20})-[a-f0-9]{64}$/.exec(id)?.[1] ?? null;
}

export function applicationGatewayRoute(input: ApplicationGatewayInput): { id: string; route: CaddyRoute | null } {
  const plan = applicationRuntimePlan(input.runtime);
  const targets = plan.targets.filter(target => target.kind === "http").sort((a, b) => a.name.localeCompare(b.name));
  if (Object.keys(input.hosts).sort().join("\0") !== targets.map(target => target.name).sort().join("\0")) {
    throw new Error("APPLICATION_GATEWAY_TARGETS_INVALID");
  }
  const id = `${APPLICATION_ROUTE_PREFIX}${plan.projectRef}-${stableSha256({
    applicationId: plan.applicationId, environmentId: plan.environmentId,
  })}`;
  const allHosts = new Set<string>();
  const routes = targets.map(target => {
    const values = input.hosts[target.name];
    if (!Array.isArray(values) || values.length === 0 || values.length > 32) {
      throw new Error("APPLICATION_GATEWAY_HOSTS_INVALID");
    }
    const hosts = values.map(value => {
      if (typeof value !== "string") throw new Error("APPLICATION_GATEWAY_HOSTS_INVALID");
      const host = value.toLowerCase();
      if (host.length > 253 || !host.split(".").every(label =>
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
        throw new Error("APPLICATION_GATEWAY_HOSTS_INVALID");
      }
      if (allHosts.has(host)) throw new Error("APPLICATION_GATEWAY_HOST_CONFLICT");
      allHosts.add(host);
      return host;
    }).sort();
    return {
      "@id": `${id}-${plan.activationId}-${target.name}`,
      match: [{ host: hosts }],
      handle: [makeReverseProxy(`127.0.0.1:${target.port}`, {}, 60_000, true)],
      terminal: true,
    };
  });
  return {
    id,
    route: routes.length ? {
      "@id": id, match: [{ host: [...allHosts].sort() }],
      handle: [{ handler: "subroute", routes }], terminal: true,
    } : null,
  };
}

function routeHosts(route: CaddyRoute): string[] {
  if (!Array.isArray(route.match)) return [];
  return route.match.flatMap((match: unknown) =>
    match && typeof match === "object" && "host" in match && Array.isArray(match.host)
      ? match.host.filter((host): host is string => typeof host === "string") : []);
}

function overlaps(host: string, candidate: string): boolean {
  const normalized = candidate.toLowerCase();
  if (normalized === host || normalized === "*") return true;
  const labels = normalized.split(".");
  const actual = host.split(".");
  return labels.length === actual.length && labels.every((label, index) => label === "*" || label === actual[index]);
}

function hasUnrestrictedHostMatcher(route: CaddyRoute): boolean {
  if (!Array.isArray(route.match) || route.match.length === 0) return true;
  return route.match.some((match: unknown) =>
    !match || typeof match !== "object" || !("host" in match)
      || !Array.isArray(match.host) || match.host.length === 0);
}

/** Application hosts are exclusive; other reconcilers cannot silently shadow them. */
export function assertApplicationGatewayHosts(routes: CaddyRoute[]): void {
  for (const [index, route] of routes.entries()) {
    if (!String(route["@id"] ?? "").startsWith(APPLICATION_ROUTE_PREFIX)) continue;
    for (const [otherIndex, other] of routes.entries()) {
      if (other === route) continue;
      if ((otherIndex < index && hasUnrestrictedHostMatcher(other))
        || routeHosts(route).some(host => routeHosts(other).some(candidate => overlaps(host, candidate)))) {
        throw new Error("APPLICATION_GATEWAY_HOST_CONFLICT");
      }
    }
  }
}

export function verifyApplicationGatewayRoutes(routes: unknown, input: ApplicationGatewayInput): void {
  if (!Array.isArray(routes) || routes.some(route => !route || typeof route !== "object" || Array.isArray(route))) {
    throw new Error("APPLICATION_GATEWAY_READBACK_INVALID");
  }
  const expected = applicationGatewayRoute(input);
  const matches = (routes as CaddyRoute[]).filter(route => route["@id"] === expected.id);
  if (matches.length !== (expected.route ? 1 : 0)
    || (expected.route && stableStringify(matches[0]) !== stableStringify(expected.route))) {
    throw new Error("APPLICATION_GATEWAY_READBACK_MISMATCH");
  }
  assertApplicationGatewayHosts(routes as CaddyRoute[]);
}

/** Retirement observes activation references, never removes the shared environment route. */
export function verifyApplicationGatewayActivationAbsent(routes: unknown, input: ApplicationGatewayInput): void {
  const plan = applicationRuntimePlan(input.runtime);
  const { id } = applicationGatewayRoute(input);
  const activationPrefix = `${id}-${plan.activationId}-`;
  const ports = new Set(Object.values(input.runtime.ports));
  if (!Array.isArray(routes) || routes.some(route =>
    !route || typeof route !== "object" || Array.isArray(route))) {
    throw new Error("APPLICATION_GATEWAY_READBACK_INVALID");
  }
  const pending: unknown[] = [...routes];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) { pending.push(...value); continue; }
    const node = value as Record<string, unknown>;
    if (typeof node["@id"] === "string" && node["@id"].startsWith(activationPrefix)) {
      throw new Error("APPLICATION_GATEWAY_ACTIVATION_STILL_ROUTED");
    }
    if ("dial" in node) {
      if (typeof node.dial !== "string" || /[{}]/.test(node.dial)) {
        throw new Error("APPLICATION_GATEWAY_READBACK_INVALID");
      }
      const port = /:([0-9]+)$/.exec(node.dial)?.[1];
      if (port && ports.has(Number(port))) throw new Error("APPLICATION_GATEWAY_ACTIVATION_STILL_ROUTED");
    }
    if (node.handler === "reverse_proxy" && node.dynamic_upstreams !== undefined) {
      throw new Error("APPLICATION_GATEWAY_READBACK_INVALID");
    }
    pending.push(...Object.values(node));
  }
}
