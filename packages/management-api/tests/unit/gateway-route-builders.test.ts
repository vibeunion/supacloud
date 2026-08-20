import { describe, expect, test } from "bun:test";

import { config } from "../../src/config";
import {
    MAX_CUSTOM_GATEWAY_PATHS,
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
            managed_upstream: undefined,
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

    test("rejects reserved proxy request headers case-insensitively", () => {
        for (const header of [
            "X-Project-Ref",
            "x-SuPaBaSe-PrOjEcT",
            "X-SupaCloud-Internal-Auth",
            "x-SUPACLOUD-internal-token",
        ]) {
            expect(() => normalizeCustomGatewayRoute({
                id: "reserved-header",
                hosts: ["api.example.com"],
                path: "/*",
                upstream: "127.0.0.1:8080",
                headers: { [header]: "untrusted" },
            })).toThrow(`must not override reserved header: ${header}`);
        }

        expect(() => normalizeCustomGatewayRoute({
            id: "reserved-managed-header",
            hosts: ["functions.example.com"],
            path: "/*",
            managed_upstream: "edge-functions",
            headers: { "x-project-ref": "other-project" },
        })).toThrow("must not override reserved header: x-project-ref");
    });

    test("keeps supported proxy overrides and response headers compatible", () => {
        const proxy = makeCustomGatewayRoute("project-ref", {
            id: "virtual-host",
            hosts: ["api.example.com"],
            path: "/*",
            upstream: "127.0.0.1:8080",
            headers: {
                Host: "upstream.example.com",
                "X-Forwarded-Host": "public.example.com",
                "X-Service": "reports",
            },
        }) as any;
        const proxyHeaders = proxy.handle[0].headers.request.set;

        expect(proxyHeaders.Host).toEqual(["upstream.example.com"]);
        expect(proxyHeaders["X-Forwarded-Host"]).toEqual(["public.example.com"]);
        expect(proxyHeaders["X-Service"]).toEqual(["reports"]);
        expect(proxyHeaders["X-Project-Ref"]).toEqual(["project-ref"]);
        expect(proxyHeaders["x-project-ref"]).toEqual(["project-ref"]);

        const staticRoute = makeCustomGatewayRoute("project-ref", {
            id: "static-response-header",
            hosts: ["static.example.com"],
            path: "/*",
            static_root: "/var/www/static",
            headers: { "X-Project-Ref": "response-value" },
        }) as any;
        const redirectRoute = makeCustomGatewayRoute("project-ref", {
            id: "redirect-response-header",
            hosts: ["www.example.com"],
            path: "/*",
            redirect_to: "https://example.com{http.request.uri}",
            headers: { "X-SupaCloud-Internal-Auth": "response-value" },
        }) as any;

        expect(staticRoute.handle[0].response.set["X-Project-Ref"]).toEqual(["response-value"]);
        expect(redirectRoute.handle[0].headers["X-SupaCloud-Internal-Auth"]).toEqual(["response-value"]);
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

    test("accepts the maximum bounded hosted route path count", () => {
        const hostedPaths = Array.from(
            { length: MAX_CUSTOM_GATEWAY_PATHS },
            (_, index) => `/hosted-${index}`,
        );
        const normalized = normalizeCustomGatewayRoute({
            id: "hosted-auth",
            hosts: ["auth.example.com"],
            path: hostedPaths,
            upstream: "127.0.0.1:9000",
        });
        const caddyRoute = makeCustomGatewayRoute("project-ref", normalized) as any;

        expect(normalized.path).toEqual(hostedPaths);
        expect(caddyRoute.match).toEqual([{ host: ["auth.example.com"], path: hostedPaths }]);

        const excessivePaths = Array.from(
            { length: MAX_CUSTOM_GATEWAY_PATHS + 1 },
            (_, index) => `/excessive-${index}`,
        );
        expect(() => normalizeCustomGatewayRoute({
            id: "too-many-paths",
            hosts: ["auth.example.com"],
            path: excessivePaths,
            upstream: "127.0.0.1:9000",
        })).toThrow(`Custom route requires 1-${MAX_CUSTOM_GATEWAY_PATHS} paths`);
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

    test("resolves the managed Edge Functions upstream from the current runtime config", () => {
        const originalEdgeRuntimeInternal = config.edgeRuntimeInternal;
        try {
            for (const edgeRuntimeInternal of [
                "127.0.0.1:9005",
                "127.0.0.1:9000",
                "edge-runtime:9005",
            ]) {
                config.edgeRuntimeInternal = edgeRuntimeInternal;
                const normalized = normalizeCustomGatewayRoute({
                    id: "sync-function",
                    hosts: ["function.example.com"],
                    path: "/invoke/*",
                    managed_upstream: "edge-functions",
                    rewrite_uri: "/functions/v1/example{http.request.uri.path}",
                    headers: { "X-Service": "functions" },
                    cors: ["https://app.example.com"],
                });
                const route = makeCustomGatewayRoute("project-ref", normalized) as any;
                const proxy = route.handle.find((handler: any) => handler.handler === "reverse_proxy");

                expect(normalized.upstream).toBeUndefined();
                expect(normalized.managed_upstream).toBe("edge-functions");
                expect(route.handle.some((handler: any) => handler.handler === "subroute")).toBe(true);
                expect(route.handle.some((handler: any) => handler.handler === "rewrite")).toBe(true);
                expect(proxy.upstreams).toEqual([{ dial: edgeRuntimeInternal }]);
                expect(proxy.transport.read_timeout).toBe("500s");
                expect(proxy.flush_interval).toBe(-1);
                expect(proxy.headers.request.set["X-Project-Ref"]).toEqual(["project-ref"]);
                expect(proxy.headers.request.set["x-project-ref"]).toEqual(["project-ref"]);
                expect(proxy.headers.request.set["X-Service"]).toEqual(["functions"]);
                expect(proxy.headers.request.set["x-supacloud-internal-auth"]).toBeUndefined();
                expect(proxy.headers.request.set["x-supacloud-internal-token"]).toBeUndefined();
            }
        } finally {
            config.edgeRuntimeInternal = originalEdgeRuntimeInternal;
        }
    });

    test("rejects unknown or conflicting managed upstream modes", () => {
        const base = {
            id: "ambiguous-upstream",
            hosts: ["api.example.com"],
            path: "/*",
        };
        const conflicts = [
            { upstream: "127.0.0.1:8080", managed_upstream: "edge-functions" },
            { upstream: "127.0.0.1:8080", static_root: "/var/www/example" },
            { upstream: "127.0.0.1:8080", redirect_to: "https://www.example.com{http.request.uri}" },
            { managed_upstream: "edge-functions", static_root: "/var/www/example" },
            { managed_upstream: "edge-functions", redirect_to: "https://www.example.com{http.request.uri}" },
            { static_root: "/var/www/example", redirect_to: "https://www.example.com{http.request.uri}" },
        ];

        for (const conflict of conflicts) {
            expect(() => normalizeCustomGatewayRoute({ ...base, ...conflict } as any))
                .toThrow("exactly one of upstream, managed_upstream, static_root or redirect_to");
        }
        expect(() => normalizeCustomGatewayRoute({
            ...base,
            managed_upstream: "unknown-managed-service",
        } as any)).toThrow("managed_upstream must be edge-functions");
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
            vars: {
                "{http.request.scheme}": "http",
            },
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
        })).toThrow("exactly one of upstream, managed_upstream, static_root or redirect_to");

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
    test("renders static SPA route with try_files fallback", () => {
        const route = makeCustomGatewayRoute("proj1", {
            id: "spa-admin",
            hosts: ["admin.example.com"],
            path: "/admin*",
            static_root: "/opt/app/build",
            strip_prefix: "/admin",
            spa: true,
        });

        expect(route).toBeDefined();
        expect(route?.["@id"]).toBe("route-custom-gateway-proj1-spa-admin");
        const handle = route?.handle as any[];
        expect(handle).toHaveLength(2);
        expect(handle[0]).toEqual({ handler: "rewrite", strip_path_prefix: "/admin" });
        expect(handle[1].handler).toBe("subroute");
        const subroutes = handle[1].routes;
        expect(subroutes[0].match[0].file.try_files).toEqual(["{http.request.uri.path}", "{http.request.uri.path}/", "/index.html"]);
        expect(subroutes[0].handle[0]).toEqual({ handler: "rewrite", uri: "{http.matchers.file.relative}" });
        expect(subroutes[1].handler).toBe("file_server");

        expect(() => normalizeCustomGatewayRoute({
            id: "spa-without-static",
            hosts: ["admin.example.com"],
            path: "/*",
            upstream: "127.0.0.1:3000",
            spa: true,
        })).toThrow("Custom route spa option requires static_root");
    });
});
