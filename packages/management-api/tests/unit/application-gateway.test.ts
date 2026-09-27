// @supacloud-test-isolate
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applicationReleaseId } from "@supacloud/delivery";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../src/config";
import {
  applicationGatewayRoute, verifyApplicationGatewayRoutes, type ApplicationGatewayInput,
} from "../../src/services/application-gateway";
import { CaddyGatewayProvider } from "../../src/services/gateway.service";
import { isCaddyRouteDomain } from "../../src/utils/caddy-domains";
import { runtimeInput } from "../helpers/application-runtime";

const originalFetch = globalThis.fetch;
const originalPath = config.caddyConfigPath;
const originalState = config.caddyStateDir;
let directory: string;
let live: any;
let loads: number;
let rejectLoad: boolean;
let loseLoadResponse: boolean;

function input(): ApplicationGatewayInput {
  return { runtime: runtimeInput(), hosts: { api: ["reviews.example.test"] } };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "supacloud-application-gateway-"));
  config.caddyConfigPath = join(directory, "caddy.json");
  config.caddyStateDir = directory;
  live = null;
  loads = 0;
  rejectLoad = false;
  loseLoadResponse = false;
  globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
    const url = String(request);
    if (url.endsWith("/load") && init?.method === "POST") {
      loads++;
      if (rejectLoad) return new Response("rejected", { status: 400 });
      live = JSON.parse(String(init.body));
      if (loseLoadResponse) throw new Error("lost response");
      return new Response("{}");
    }
    if (url.endsWith("/config/")) return Response.json(live ?? {});
    if (url.endsWith("/config/apps/http/servers/supacloud/routes")) {
      return Response.json(live?.apps?.http?.servers?.supacloud?.routes ?? []);
    }
    return new Response("{}");
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  config.caddyConfigPath = originalPath;
  config.caddyStateDir = originalState;
  await rm(directory, { recursive: true, force: true });
});

describe("application gateway", () => {
  test("binds activation and all HTTP targets, leaving worker targets unrouted", () => {
    const desired = input();
    const { id, route } = applicationGatewayRoute(desired);
    expect(id).toStartWith("route-application-demo-");
    expect(JSON.stringify(route)).toContain(desired.runtime.activationId);
    expect(JSON.stringify(route)).toContain("127.0.0.1:31000");
    expect(JSON.stringify(route)).not.toContain("jobs");
    expect(() => verifyApplicationGatewayRoutes([route], desired)).not.toThrow();
    const moved = structuredClone(desired);
    moved.runtime.activationId = "11234567-89ab-4def-8123-456789abcdef";
    expect(applicationGatewayRoute(moved).id).toBe(id);
    expect(() => verifyApplicationGatewayRoutes([route], moved)).toThrow("READBACK_MISMATCH");
    expect(() => verifyApplicationGatewayRoutes([route, route], desired)).toThrow("READBACK_MISMATCH");
  });

  test("rejects missing bindings, worker bindings, wildcard hosts and duplicate hosts", () => {
    const bindings: ApplicationGatewayInput["hosts"][] = [{}, { jobs: ["jobs.test"] }, { api: ["*.example.test"] },
      { api: ["reviews.example.test", "REVIEWS.EXAMPLE.TEST"] }, { api: ["https://example.test"] }];
    for (const hosts of bindings) {
      expect(() => applicationGatewayRoute({ ...input(), hosts })).toThrow();
    }
  });

  test("routes multiple HTTP targets as one group with distinct loopback ports", async () => {
    const desired = input();
    desired.runtime.release.targets.push({
      name: "web", kind: "http", object_id: "d".repeat(64), entrypoint: "bundle/index.js",
    });
    desired.runtime.ports = { api: 31000, web: 31001 };
    desired.hosts = { api: ["reviews.example.test"], web: ["web.example.test"] };
    const provider = new CaddyGatewayProvider();
    await provider.configureApplicationRoute(desired);
    await provider.verifyApplicationRoute(desired);
    expect(loads).toBe(1);
    const routes = live.apps.http.servers.supacloud.routes;
    expect(JSON.stringify(routes)).toContain("127.0.0.1:31000");
    expect(JSON.stringify(routes)).toContain("127.0.0.1:31001");
    expect(await isCaddyRouteDomain("reviews.example.test")).toBe(true);
    expect(await isCaddyRouteDomain("web.example.test")).toBe(true);
    desired.hosts = { api: ["reviews.example.test"], web: ["REVIEWS.EXAMPLE.TEST"] };
    await expect(provider.configureApplicationRoute(desired)).rejects.toThrow("HOST_CONFLICT");
    expect(loads).toBe(1);
  });

  test("persists and reads back routes across restart, frontend changes and clean rebuild", async () => {
    const desired = input();
    const provider = new CaddyGatewayProvider();
    await provider.configureApplicationRoute(desired);
    await provider.configureFrontendRoute({
      projectRef: "demo", deploymentId: "web", hosts: ["web.example.test"], port: 31001,
    });
    await provider.setCors("demo", ["https://web.example.test"]);
    await provider.removeProjectDomains("demo", ["reviews.example.test"], []);
    await provider.verifyApplicationRoute(desired);
    const restarted = new CaddyGatewayProvider();
    await restarted.prepareCleanRebuild();
    await restarted.configureFrontendRoute({
      projectRef: "demo", deploymentId: "web", hosts: ["web.example.test"], port: 31001,
    });
    await restarted.verifyApplicationRoute(desired);
    expect(JSON.parse(await readFile(config.caddyConfigPath, "utf8"))).toEqual(live);
    expect(loads).toBe(5);
  });

  test("switches atomically to another activation and back under a fresh activation ID", async () => {
    const provider = new CaddyGatewayProvider();
    const old = input();
    await provider.configureApplicationRoute(old);
    const next = structuredClone(old);
    next.runtime.activationId = "11234567-89ab-4def-8123-456789abcdef";
    next.runtime.ports = { api: 32000 };
    await provider.configureApplicationRoute(next);
    await expect(provider.verifyApplicationRoute(old)).rejects.toThrow("READBACK_MISMATCH");
    const rollback = structuredClone(old);
    rollback.runtime.activationId = "21234567-89ab-4def-8123-456789abcdef";
    await provider.configureApplicationRoute(rollback);
    expect(JSON.stringify(live)).not.toContain(next.runtime.activationId);
    await provider.verifyApplicationRoute(rollback);
  });

  test("retirement observes old activation absence without removing the new route", async () => {
    const desired = input();
    const provider = new CaddyGatewayProvider();
    await provider.configureApplicationRoute(desired);
    await expect(provider.verifyApplicationRouteAbsent(desired)).rejects.toThrow("STILL_ROUTED");
    const next = structuredClone(desired);
    next.runtime.activationId = "11234567-89ab-4def-8123-456789abcdef";
    next.runtime.ports = { api: 32000 };
    await provider.configureApplicationRoute(next);
    const published = loads;
    await provider.verifyApplicationRouteAbsent(desired);
    await provider.verifyApplicationRoute(next);
    expect(loads).toBe(published);
  });

  test("retirement rejects a stale durable route and an aliased upstream to the old port", async () => {
    const desired = input();
    const provider = new CaddyGatewayProvider();
    await provider.configureApplicationRoute(desired);
    const stale = structuredClone(live);
    const next = structuredClone(desired);
    next.runtime.activationId = "11234567-89ab-4def-8123-456789abcdef";
    next.runtime.ports = { api: 32000 };
    await provider.configureApplicationRoute(next);
    const current = await readFile(config.caddyConfigPath, "utf8");
    await writeFile(config.caddyConfigPath, JSON.stringify(stale));
    await expect(provider.verifyApplicationRouteAbsent(desired)).rejects.toThrow("STILL_ROUTED");
    await writeFile(config.caddyConfigPath, current);
    live.apps.http.servers.supacloud.routes.push({
      "@id": "unrelated-alias", handle: [{
        handler: "reverse_proxy", upstreams: [{ dial: "localhost:31000" }],
      }],
    });
    await expect(provider.verifyApplicationRouteAbsent(desired)).rejects.toThrow("STILL_ROUTED");
  });

  test("retirement refuses malformed route readback", async () => {
    const provider = new CaddyGatewayProvider();
    const desired = input();
    await provider.configureApplicationRoute(desired);
    live.apps.http.servers.supacloud.routes = [null];
    await expect(provider.verifyApplicationRouteAbsent(desired)).rejects.toThrow("READBACK_INVALID");
  });

  test("rejected loads retain prior route and lost responses use actual readback", async () => {
    const provider = new CaddyGatewayProvider();
    const old = input();
    await provider.configureApplicationRoute(old);
    const next = structuredClone(old);
    next.runtime.ports = { api: 32000 };
    rejectLoad = true;
    await expect(provider.configureApplicationRoute(next)).rejects.toThrow("400");
    await provider.verifyApplicationRoute(old);
    rejectLoad = false;
    loseLoadResponse = true;
    await provider.configureApplicationRoute(next);
    await provider.verifyApplicationRoute(next);
  });

  test("rejects different live or durable route contents", async () => {
    const desired = input();
    const provider = new CaddyGatewayProvider();
    await provider.configureApplicationRoute(desired);
    const saved = structuredClone(live);
    live.apps.http.servers.supacloud.routes = [];
    await expect(provider.verifyApplicationRoute(desired)).rejects.toThrow("READBACK_MISMATCH");
    live = saved;
    const corrupted = structuredClone(saved);
    corrupted.apps.http.servers.supacloud.routes = [];
    await writeFile(config.caddyConfigPath, JSON.stringify(corrupted));
    await expect(provider.verifyApplicationRoute(desired)).rejects.toThrow("READBACK_MISMATCH");
  });

  test("keeps a live non-durable activation quarantined until persistence can be repaired", async () => {
    let failSync = false;
    const provider = new CaddyGatewayProvider({
      beforeDurabilityStage: async stage => {
        if (failSync && stage === "candidate_sync") throw new Error("sync unavailable");
      },
    });
    const old = input();
    await provider.configureApplicationRoute(old);
    const next = structuredClone(old);
    next.runtime.activationId = "11234567-89ab-4def-8123-456789abcdef";
    next.runtime.ports = { api: 32000 };
    failSync = true;
    await expect(provider.configureApplicationRoute(next)).rejects.toThrow("durable");
    verifyApplicationGatewayRoutes(live.apps.http.servers.supacloud.routes, next);
    const durable = JSON.parse(await readFile(config.caddyConfigPath, "utf8"));
    verifyApplicationGatewayRoutes(durable.apps.http.servers.supacloud.routes, old);
    await expect(provider.configureFrontendRoute({
      projectRef: "other", deploymentId: "web", hosts: ["web.example.test"], port: 31001,
    })).rejects.toThrow("durability");
    expect(loads).toBe(2);
    failSync = false;
    await provider.verifyApplicationRoute(next);
    expect(loads).toBe(2);
    expect(JSON.parse(await readFile(config.caddyConfigPath, "utf8"))).toEqual(live);
  });

  test("prevents frontend or wildcard routes from shadowing application hosts", async () => {
    const desired = input();
    const provider = new CaddyGatewayProvider();
    await provider.configureApplicationRoute(desired);
    for (const host of ["reviews.example.test", "*.example.test"]) {
      await expect(provider.configureFrontendRoute({
        projectRef: "other", deploymentId: "web", hosts: [host], port: 31001,
      })).rejects.toThrow("HOST_CONFLICT");
    }
    await provider.verifyApplicationRoute(desired);
    expect(loads).toBe(1);
  });

  test("invalid tenant-domain reconciliation does not poison subsequent publishes", async () => {
    const provider = new CaddyGatewayProvider();
    const desired = input();
    await provider.configureApplicationRoute(desired);
    expect((await provider.setupUpstream("demo", 3000, 9999)).success).toBe(true);
    await expect(provider.addProjectDomains("demo", ["reviews.example.test"], []))
      .rejects.toThrow("HOST_CONFLICT");
    await provider.setCors("demo", ["https://web.example.test"]);
    await provider.verifyApplicationRoute(desired);
    expect(loads).toBe(3);
  });

  test("removes the route for worker-only releases and project deletion", async () => {
    const provider = new CaddyGatewayProvider();
    const desired = input();
    await provider.configureApplicationRoute(desired);
    const worker = structuredClone(desired);
    worker.runtime.release.targets = worker.runtime.release.targets.filter(target => target.kind === "worker");
    worker.runtime.ports = {};
    worker.hosts = {};
    await provider.configureApplicationRoute(worker);
    await provider.verifyApplicationRoute(worker);
    await provider.configureApplicationRoute(desired);
    await provider.removeService("demo");
    await expect(provider.verifyApplicationRoute(desired)).rejects.toThrow("READBACK_MISMATCH");
  });

  test("project deletion cannot confuse application route family with tenant ownership", async () => {
    const provider = new CaddyGatewayProvider();
    const desired = input();
    await provider.configureApplicationRoute(desired);
    await provider.removeService("application");
    await provider.removeService("de");
    await provider.verifyApplicationRoute(desired);
    const sibling = structuredClone(desired);
    sibling.runtime.release.project_ref = "demo-west";
    sibling.runtime.release.release_id = applicationReleaseId(
      "demo-west", sibling.runtime.release.application_id, sibling.runtime.release.manifest_sha256,
    );
    sibling.hosts = { api: ["west.example.test"] };
    await provider.configureApplicationRoute(sibling);
    await provider.removeService("demo");
    await expect(provider.verifyApplicationRoute(desired)).rejects.toThrow("READBACK_MISMATCH");
    await provider.verifyApplicationRoute(sibling);
    await provider.removeService("demo-west");
    await expect(provider.verifyApplicationRoute(sibling)).rejects.toThrow("READBACK_MISMATCH");
  });

  test("detects host-unrestricted routes ahead of the application but permits trailing fallback", async () => {
    const desired = input();
    const { route } = applicationGatewayRoute(desired);
    const fallback = { "@id": "fallback", handle: [{ handler: "static_response", body: "intercepted" }], terminal: true };
    expect(() => verifyApplicationGatewayRoutes([fallback, route], desired)).toThrow("HOST_CONFLICT");
    for (const match of [[], [{}], [{ host: [] }], [{ host: ["other.test"] }, { path: ["/intercept"] }]]) {
      expect(() => verifyApplicationGatewayRoutes([{ ...fallback, match }, route], desired)).toThrow("HOST_CONFLICT");
    }
    expect(() => verifyApplicationGatewayRoutes([route, fallback], desired)).not.toThrow();
    const provider = new CaddyGatewayProvider();
    await provider.configureApplicationRoute(desired);
    live.apps.http.servers.supacloud.routes.unshift(fallback);
    await expect(provider.verifyApplicationRoute(desired)).rejects.toThrow("HOST_CONFLICT");
    const durable = JSON.parse(await readFile(config.caddyConfigPath, "utf8"));
    durable.apps.http.servers.supacloud.routes.unshift(fallback);
    await writeFile(config.caddyConfigPath, JSON.stringify(durable));
    const restarted = new CaddyGatewayProvider();
    await expect(restarted.configureApplicationRoute(desired)).rejects.toThrow("HOST_CONFLICT");
  });

  test("does not issue an uncommitted receipt inside a deferred reconciliation", async () => {
    const provider = new CaddyGatewayProvider();
    await expect(provider.withDeferredPersist(() => provider.configureApplicationRoute(input())))
      .rejects.toThrow("DEFERRED_WRITE");
    expect(loads).toBe(0);
  });
});
