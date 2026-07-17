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
            protocol: undefined,
            redirect_to: undefined,
            redirect_status: undefined,
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

    test("renders a protocol-scoped permanent redirect and preserves the request URI", () => {
        const normalized = normalizeCustomGatewayRoute({
            id: "canonical-https",
            hosts: ["WWW.EXAMPLE.COM"],
            path: "/*",
            protocol: "http",
            redirect_to: "https://www.example.com{http.request.uri}",
            headers: { "Cache-Control": "no-store" },
        });
        const route = makeCustomGatewayRoute("project-ref", normalized) as any;

        expect(normalized.redirect_status).toBe(308);
        expect(route.match).toEqual([{
            host: ["www.example.com"],
            path: ["/*"],
            protocol: "http",
        }]);
        expect(route.handle).toEqual([{
            handler: "static_response",
            headers: {
                "Cache-Control": ["no-store"],
                Location: ["https://www.example.com{http.request.uri}"],
            },
            status_code: 308,
        }]);
    });

    test("rejects ambiguous or unsafe redirect routes", () => {
        expect(() => normalizeCustomGatewayRoute({
            id: "ambiguous",
            hosts: ["www.example.com"],
            path: "/*",
            upstream: "127.0.0.1:8080",
            redirect_to: "https://www.example.com{http.request.uri}",
        })).toThrow("exactly one of upstream, static_root or redirect_to");

        expect(() => normalizeCustomGatewayRoute({
            id: "bad-placeholder",
            hosts: ["www.example.com"],
            path: "/*",
            redirect_to: "https://www.example.com{http.request.host}",
        })).toThrow("only supports the {http.request.uri} placeholder");

        expect(() => normalizeCustomGatewayRoute({
            id: "bad-status",
            hosts: ["www.example.com"],
            path: "/*",
            redirect_to: "https://www.example.com{http.request.uri}",
            redirect_status: 303 as any,
        })).toThrow("must be one of 301, 302, 307 or 308");

        expect(() => normalizeCustomGatewayRoute({
            id: "bad-location-header",
            hosts: ["www.example.com"],
            path: "/*",
            redirect_to: "https://www.example.com{http.request.uri}",
            headers: { location: "https://evil.example.com" },
        })).toThrow("must not override the Location header");

        expect(() => normalizeCustomGatewayRoute({
            id: "status-without-redirect",
            hosts: ["www.example.com"],
            path: "/*",
            static_root: "/var/www/example",
            redirect_status: 308,
        })).toThrow("redirect_status requires redirect_to");

        expect(() => normalizeCustomGatewayRoute({
            id: "bad-protocol",
            hosts: ["www.example.com"],
            path: "/*",
            static_root: "/var/www/example",
            protocol: "ftp" as any,
        })).toThrow("protocol must be http or https");

        for (const redirect_to of [
            "javascript:alert(1)",
            "https://user:password@www.example.com/",
            "https://{http.request.uri}",
            "https://{http.request.uri}.example.com/",
            "https://www.example.com/\r\nX-Injected: true",
        ]) {
            expect(() => normalizeCustomGatewayRoute({
                id: "bad-target",
                hosts: ["www.example.com"],
                path: "/*",
                redirect_to,
            })).toThrow();
        }
    });
});
