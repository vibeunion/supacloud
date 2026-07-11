import { describe, expect, test } from "bun:test";

import {
    makeCorsSubroute,
    makeCustomGatewayRoute,
    normalizeCustomGatewayRoute,
} from "../../src/services/gateway-route-builders";

describe("gateway route builders", () => {
    test("normalizes a proxy route without weakening host or path validation", () => {
        expect(normalizeCustomGatewayRoute({
            id: "reports",
            hosts: ["HTTPS://API.EXAMPLE.COM:443", "api.example.com"],
            path: ["/reports/*", "/reports/*"],
            upstream: "https://reports.internal",
            headers: { "X-Service": "reports" },
            cors: ["https://app.example.com"],
        })).toEqual({
            id: "reports",
            hosts: ["api.example.com"],
            path: ["/reports/*"],
            upstream: "https://reports.internal",
            upstream_tls_insecure_skip_verify: false,
            static_root: undefined,
            rewrite_uri: undefined,
            strip_prefix: undefined,
            headers: { "X-Service": "reports" },
            cors: ["https://app.example.com"],
            priority: 0,
            enabled: true,
        });

        expect(() => normalizeCustomGatewayRoute({
            id: "bad",
            hosts: ["api.example.com"],
            path: "/ok\r\nX-Injected: true",
            upstream: "reports.internal:8080",
        })).toThrow("control characters");
    });

    test("builds exact and regex CORS matchers with a terminal preflight", () => {
        const subroute = makeCorsSubroute([
            "https://app.example.com",
            "~^https://preview-[a-z0-9]+\\.example\\.com$",
        ]) as any;

        expect(subroute.handler).toBe("subroute");
        expect(subroute.routes[0].terminal).toBe(true);
        expect(subroute.routes[0].handle.at(-1)).toEqual({ handler: "static_response", status_code: 204 });
        expect(subroute.routes[0].match.some((matcher: any) => matcher.header?.Origin?.includes("https://app.example.com"))).toBe(true);
        expect(subroute.routes[0].match.some((matcher: any) => matcher.header_regexp?.Origin?.pattern?.includes("preview-"))).toBe(true);
    });

    test("renders a custom HTTPS proxy route with the existing Caddy shape", () => {
        const route = makeCustomGatewayRoute("project-ref", {
            id: "reports",
            hosts: ["api.example.com"],
            path: "/reports/*",
            upstream: "https://reports.internal",
            strip_prefix: "/reports",
            priority: 20,
        }) as any;

        expect(route["@id"]).toBe("route-custom-gateway-project-ref-reports");
        expect(route.match).toEqual([{ host: ["api.example.com"], path: ["/reports/*"] }]);
        expect(route.handle[0]).toEqual({ handler: "rewrite", strip_path_prefix: "/reports" });
        expect(route.handle[1].upstreams).toEqual([{ dial: "reports.internal:443" }]);
        expect(route.handle[1].transport.tls).toEqual({});
        expect(route.handle[1].headers.request.set["X-Project-Ref"]).toEqual(["project-ref"]);
    });
});
