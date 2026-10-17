import { afterEach, describe, test } from "bun:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { config } from "../../src/config";
import {
    isCorsSubroute,
    makeCorsSubroute,
    makeReverseProxy,
    routePreservesUpstreamCors,
    setRouteCors,
    type CaddyRoute,
} from "../../src/services/gateway-route-builders";

const originalMode = config.edgeFunctionsCorsMode;
afterEach(() => { config.edgeFunctionsCorsMode = originalMode; });

function record(value: unknown): Record<string, unknown> {
    ok(value !== null && typeof value === "object" && !Array.isArray(value));
    return value as Record<string, unknown>;
}

function records(value: unknown): Record<string, unknown>[] {
    ok(Array.isArray(value));
    return value.map(record);
}

function responseOf(proxy: Record<string, unknown>): Record<string, unknown> {
    return record(record(proxy["headers"])["response"] ?? {});
}

function functionRoute(proxy: Record<string, unknown>): CaddyRoute {
    return { "@id": "route-project-cors-test-functions", handle: [proxy] };
}

function proxyFixture(): Record<string, unknown> {
    return makeReverseProxy("127.0.0.1:9090", {
        "X-Project-Ref": "cors-test",
        Host: "cors-test.example.com",
    }, 500_000, false);
}

describe("Function CORS ownership reconciliation", () => {
    for (const mode of ["function", "permissive"] as const) {
        test(`auto to ${mode} restores upstream CORS without changing routing or request headers`, () => {
            const proxy = proxyFixture();
            const request = structuredClone(record(proxy["headers"])["request"]);
            const transport = structuredClone(proxy["transport"]);
            const upstreams = structuredClone(proxy["upstreams"]);
            const route = functionRoute(proxy);
            config.edgeFunctionsCorsMode = "auto";
            setRouteCors(route, ["https://app.example.com"]);
            equal(routePreservesUpstreamCors(route), false);

            config.edgeFunctionsCorsMode = mode;
            setRouteCors(route, ["https://app.example.com"]);
            equal(responseOf(proxy)["delete"], undefined);
            equal(routePreservesUpstreamCors(route), true);
            equal(records(route["handle"]).filter(isCorsSubroute).length, 0);
            equal(records(route["handle"]).filter((handler) => "errors" in handler).length, 1);
            deepEqual(record(proxy["headers"])["request"], request);
            deepEqual(proxy["transport"], transport);
            deepEqual(proxy["upstreams"], upstreams);

            const once = structuredClone(route);
            setRouteCors(route, ["https://app.example.com"]);
            deepEqual(route, once);
        });

        test(`${mode} removes only CORS deletions, including legacy casing`, () => {
            const proxy = proxyFixture();
            responseOf(proxy)["delete"] = ["Server", "access-control-allow-origin", "ACCESS-CONTROL-ALLOW-CREDENTIALS", "X-Powered-By"];
            config.edgeFunctionsCorsMode = mode;
            setRouteCors(functionRoute(proxy), ["https://app.example.com"]);
            deepEqual(responseOf(proxy)["delete"], ["Server", "X-Powered-By"]);
        });
    }

    test("auto clears stale CORS transformations while retaining unrelated response policy", () => {
        const proxy = proxyFixture();
        const response = responseOf(proxy);
        response["delete"] = ["Server", "access-control-allow-origin", "X-Powered-By"];
        response["set"] = { "Access-Control-Allow-Origin": ["https://old.example.com"], "access-control-allow-credentials": ["true"], "X-Safe": ["keep"] };
        response["add"] = { "ACCESS-CONTROL-ALLOW-ORIGIN": ["*"], Vary: ["Accept-Encoding"] };
        response["replace"] = { "Access-Control-Allow-Origin": [{ search: "old", replace: "new" }], "X-Safe": [{ search: "before", replace: "after" }] };
        config.edgeFunctionsCorsMode = "auto";
        setRouteCors(functionRoute(proxy), ["https://app.example.com"]);
        deepEqual(response["set"], { "X-Safe": ["keep"] });
        deepEqual(response["add"], { Vary: ["Accept-Encoding"] });
        deepEqual(response["replace"], { "X-Safe": [{ search: "before", replace: "after" }] });
        deepEqual(response["delete"], [
            "Server", "X-Powered-By", "Access-Control-Allow-Origin", "Access-Control-Allow-Credentials",
            "Access-Control-Allow-Methods", "Access-Control-Allow-Headers", "Access-Control-Expose-Headers", "Access-Control-Max-Age",
        ]);
    });

    test("repeated auto reconciliation keeps one wildcard policy for preflight and ordinary responses", () => {
        const proxy = proxyFixture();
        const route = functionRoute(proxy);
        config.edgeFunctionsCorsMode = "function";
        setRouteCors(route, ["https://old.example.com"]);
        config.edgeFunctionsCorsMode = "auto";
        setRouteCors(route, ["https://app.example.com"]);
        const once = structuredClone(route);
        setRouteCors(route, []);
        deepEqual(route, once);
        const cors = records(route["handle"]).filter(isCorsSubroute);
        equal(cors.length, 1);
        equal(records(route["handle"]).filter((handler) => "errors" in handler).length, 0);
        const routes = records(record(cors[0])["routes"]);
        equal(routes.length, 2);
        for (const item of routes) {
            const header = records(item["handle"]).find((handler) => handler["handler"] === "headers");
            const set = record(record(record(header)["response"])["set"]);
            deepEqual(set["Access-Control-Allow-Origin"], ["*"]);
            equal(set["Access-Control-Allow-Credentials"], undefined);
        }
        equal(routePreservesUpstreamCors(route), false);
    });

    for (const id of ["route-project-cors-test-storage", "route-custom-gateway-cors-test-functions"]) {
        test(`auto leaves upstream-owned or custom policy untouched: ${id}`, () => {
            const proxy = makeReverseProxy("127.0.0.1:9090", {}, 500_000, true);
            const route: CaddyRoute = { "@id": id, handle: [proxy] };
            const before = structuredClone(route);
            config.edgeFunctionsCorsMode = "auto";
            setRouteCors(route, ["https://app.example.com"]);
            deepEqual(route, before);
        });
    }

    test("REST keeps the supplied exact-origin policy in auto mode", () => {
        const proxy = proxyFixture();
        const route: CaddyRoute = { "@id": "route-project-cors-test-rest", handle: [proxy] };
        config.edgeFunctionsCorsMode = "auto";
        setRouteCors(route, ["https://app.example.com"]);
        deepEqual(records(route["handle"])[0], makeCorsSubroute(["https://app.example.com"]));
    });
});
