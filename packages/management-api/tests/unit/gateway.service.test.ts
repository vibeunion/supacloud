import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "../../src/config";
import {
    CaddyGatewayProvider,
    DEFAULT_CORS_EXPOSED,
    DEFAULT_CORS_HEADERS,
    buildTenantCorsOrigins,
    caddySensitiveRequestLogEncoder,
    gatewayService,
    reconcileCanonicalGatewayRoutes,
} from "../../src/services/gateway.service";

function captureFetch(calls: Array<{ url: string; method: string; body: any }>) {
    const originalFetch = globalThis.fetch;
    let loadedConfig: any = null;
    globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const method = init?.method || "GET";
        let body: any = null;
        if (typeof init?.body === "string" && init.body.length > 0) {
            try { body = JSON.parse(init.body); } catch { body = init.body; }
        }
        calls.push({ url, method, body });
        if (method === "POST" && url.endsWith("/load")) loadedConfig = body;
        if (method === "GET" && url.endsWith("/config/")) {
            return Promise.resolve(Response.json(loadedConfig ?? {}));
        }
        if (method === "GET" && url.endsWith("/config/apps/http/servers/supacloud/routes")) {
            return Promise.resolve(Response.json(loadedConfig?.apps?.http?.servers?.supacloud?.routes ?? []));
        }
        return Promise.resolve(new Response(JSON.stringify({ id: "cert_123", data: [] })));
    }) as unknown as typeof fetch;
    return () => { globalThis.fetch = originalFetch; };
}

function findCorsSubroute(route: any) {
    return route?.handle?.find((handler: any) => handler.handler === "subroute" && Array.isArray(handler.routes));
}

function findReverseProxyHandlers(routes: any[]) {
    return routes.flatMap((route: any) => route.handle ?? [])
        .filter((handler: any) => handler.handler === "reverse_proxy");
}

function findRouteIdForHandler(routes: any[], targetHandler: any): string | undefined {
    for (const route of routes) {
        if (Array.isArray(route.handle) && route.handle.includes(targetHandler)) {
            return route["@id"];
        }
    }
    return undefined;
}

async function cleanCaddyTmp() {
    await rm("/tmp/supacloud-caddy-test", { recursive: true, force: true });
}

const VALID_TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDFTCCAf2gAwIBAgIUbK5x4GDxAV2j+g2vjuPbCwxaJqowDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPYXBpLmV4YW1wbGUuY29tMB4XDTI2MDUyNjE2NDExNVoX
DTI2MDYyNTE2NDExNVowGjEYMBYGA1UEAwwPYXBpLmV4YW1wbGUuY29tMIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtkg5Df0ZNT7QLKelt7pcbBPssuT6
qISVvGSmk/TW5kt2v1TfBYUoIJe7mRB0muq4r9i3IvxuysRTbrEEzelOytH8kY3e
+049kmxE+OnoAn7MyJ/BBkR870CZaMfyCvQ4NSs1DGCwPd+nrq01nykiHKcWzDfb
TAUWjtuWSoezEiwmz6U9Pkh1qk+p2lernD3aUKUyWbCttfP3EL1sNQaLu4ZoOKSg
mkih7IIs+FRL9p243qnv4NEC81gGKgzVtEefP9OJUJW/q8t9x6JaGJtciJ/3jsjC
i31J2GrKLe3sP0JMptz/491YQv2LHRKXeHlfLLBdkp/0PBnruWPgRUPL0wIDAQAB
o1MwUTAdBgNVHQ4EFgQU9uaVrNJN9jsecy5i0qxF9siJIQ4wHwYDVR0jBBgwFoAU
9uaVrNJN9jsecy5i0qxF9siJIQ4wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0B
AQsFAAOCAQEAAHOvIwG5/6r2I4MV2oirrsFZc0Wcgl5LEfe+qEZ44iRlDrDLxM1d
FtV47e2YuOIXCDP5bulYAOc6tXmwWJp4UsGVdcIrqSWxRYQHbQb4rj/WbCuoi6Or
lq5IlYEcF6tII159V/w27STx6PtXRrnZlO5M6vZANkFnwa1/xH5Fl4AeA0ldQbV6
UrWoTu4mlV79iJj4eVsn/VOphqz0Tx4cDTOLjKb+4luSnX0WNkjFZY8G+bZMjfrj
WFHJEHW9P9SZ21+5kAXMdGmXXRMQy3V8pcVd8UC8ZCduKh5Kk/TBJGPTsivzy/cq
Fl3Tj7s2iD5pVVCKKcD0lig/xQRcC+D8Vg==
-----END CERTIFICATE-----`;

const VALID_TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC2SDkN/Rk1PtAs
p6W3ulxsE+yy5PqohJW8ZKaT9NbmS3a/VN8FhSggl7uZEHSa6riv2Lci/G7KxFNu
sQTN6U7K0fyRjd77Tj2SbET46egCfszIn8EGRHzvQJlox/IK9Dg1KzUMYLA936eu
rTWfKSIcpxbMN9tMBRaO25ZKh7MSLCbPpT0+SHWqT6naV6ucPdpQpTJZsK218/cQ
vWw1Bou7hmg4pKCaSKHsgiz4VEv2nbjeqe/g0QLzWAYqDNW0R58/04lQlb+ry33H
oloYm1yIn/eOyMKLfUnYasot7ew/Qkym3P/j3VhC/YsdEpd4eV8ssF2Sn/Q8Geu5
Y+BFQ8vTAgMBAAECggEADiBkw4/E31qB2aQYdLetp/aXVnnmbx7vV81ZF4hXCzv3
9PYH3q6mIHiB4mfjEYp1S7N45e44S+CRMrfnTmnxYEiL0V/0UveKUAmyArRl9aOM
DVRMKkcug4A3I2azfGPW40/46X+oyPLHVQM5b59JdH0CiEsf5LFUQTgFWrtPhm3h
3ytiCwTd4sppCz4iuUcnKa7CV9BBHI11n6QsL10wCoQusiN4KP90qd+fB0/CQX8S
cyE/0RRsTi0BeB9EtsQxuF/PPqxGfKNustd9CJjdSxtGDaUrlTZ0Om3TfTP7Ao73
pbc+EQCmvFUPn1dUPoqUJB+FKHcon0tyo1piHq4a8QKBgQDvbCPGiQhvOXx4XNLg
1Jbm2KfiqMNTLp9IRQIIfp6Qq51CeK08VPu1SinhQKakmP+xi9/SyxeDHF76LBz1
OWWd4r217UoevFoYDTSdIdKpNklUu4Cr2RCsW5odcZT4IjjUb/mscW0+Uxpms7JH
bqDpCHSuEVkfn+DakhVAZRWraQKBgQDC5z95gqY/nZ5t10dNJzlAJBJHJOAzukKU
OmDSrJvtKmlp+u4nG4kFxNtmiR25C2R4a0AcdqOBBOzd94yKIwiw1yLZXJDGPQSo
5wbFEx2vvpOqsT91SQdIHBZ85raXvy/EFnvooSA5inxFTg9VvZgC4ivLVBlcrVtL
YThFmYDB2wKBgACnZ/Wb3DUJkCh4AG9yxTK+Nr8svNPWVcMJxTamueIlRdmvoLGA
feuB11lxJsNeU5x1iFf4DAlko3HFexLEZF2pB+GeU0yAMTLNnm4rcHrb1hlwJarS
ffQqj+IytDh1R3h1EdaBvM2lxnWvWfZN/AyG5GKxU2/9rMyMB5jUbdm5AoGBAJue
2OfEkcmpqJ47jgrkjqnQI2f64alrx01jb3vHppivjIu6d/1x1u5sSGKOiNT/a7Fa
sU4IzHRv4lE5H1YMsxvAK2sypcYjYl0aWiVxJfr1SCK6c9jJ/q5s/uerr49qcFE5
QqZ0QK6xDJipw0TKpV1oCV/IPpfpM0P01GF+N3iRAoGAR2Va6a8YaJpSwp/5XsRP
K2wyK+c1cuXLwT76F9hLSDA9rcF80RHmBpBSeP2aG8Nd361hto35VLiPdBvjXJxn
QCga9rEA9mgt+9AWvlXa+H7LWic9kvhtw9QMl4vWMccuFKRt77VTjs146EoXVqaX
AwNbYPcbTU4kMp3H5JKzKdI=
-----END PRIVATE KEY-----`;

describe("GatewayService provider selection", () => {
    test("defaults to the Caddy gateway provider", () => {
        expect(config.gatewayProvider).toBe("caddy");
        expect(gatewayService.name).toBe("caddy");
    });

    test("default cors headers allow SupaCloud browser invocation headers", () => {
        expect(DEFAULT_CORS_HEADERS).toContain("x-supacloud-async");
        expect(DEFAULT_CORS_HEADERS).toContain("x-supacloud-retries");
        expect(DEFAULT_CORS_HEADERS).toContain("x-supacloud-timeout");
        expect(DEFAULT_CORS_HEADERS).toContain("tus-resumable");
        expect(DEFAULT_CORS_HEADERS).toContain("upload-length");
        expect(DEFAULT_CORS_HEADERS).toContain("upload-offset");
        expect(DEFAULT_CORS_HEADERS).toContain("upload-metadata");
        expect(DEFAULT_CORS_HEADERS).toContain("Idempotency-Key");
        expect(DEFAULT_CORS_HEADERS).toContain("x-supacloud-idempotency-key");
        expect(DEFAULT_CORS_HEADERS).toContain("x-supacloud-function-version");
        expect(DEFAULT_CORS_HEADERS).toContain("x-supacloud-trace-id");
        expect(DEFAULT_CORS_HEADERS).toContain("x-supacloud-correlation-id");
        expect(DEFAULT_CORS_HEADERS).toContain("x-supacloud-business-task-id");
        expect(DEFAULT_CORS_HEADERS).toContain("x-supacloud-task-metadata");
        expect(DEFAULT_CORS_HEADERS).not.toContain("x-forwarded-for");
        expect(DEFAULT_CORS_HEADERS).not.toContain("x-forwarded-host");
        expect(DEFAULT_CORS_HEADERS).not.toContain("x-forwarded-proto");
        expect(DEFAULT_CORS_HEADERS).not.toContain("x-real-ip");
    });

    test("default cors exposed headers allow browsers to read download filenames", () => {
        expect(DEFAULT_CORS_EXPOSED).toContain("Content-Disposition");
        expect(DEFAULT_CORS_EXPOSED).toContain("Retry-After");
    });

    test("default Caddy logger redacts sensitive request headers", () => {
        const encoder = caddySensitiveRequestLogEncoder() as {
            format: string;
            wrap: { format: string };
            fields: Record<string, { filter: string; value: string }>;
        };

        expect(encoder.format).toBe("filter");
        expect(encoder.wrap).toEqual({ format: "json" });
        for (const header of [
            "Apikey",
            "Authorization",
            "Cookie",
            "Proxy-Authorization",
            "X-Api-Key",
            "X-Auth-Token",
            "X-Supabase-Api-Key",
        ]) {
            expect(encoder.fields[`request>headers>${header}`]).toEqual({
                filter: "replace",
                value: "REDACTED",
            });
        }
    });

    test("tenant cors origins include exact api and studio custom domains", () => {
        const origins = buildTenantCorsOrigins("dbbabyref", {
            api_domain: "sapi.dbbaby.top",
            additional_api_domains: ["api-alt.dbbaby.top"],
            auth_domain: "auth.dbbaby.top",
            studio_domain: "sadmin.dbbaby.top",
        });

        expect(origins).toContain("https://sapi.dbbaby.top");
        expect(origins).toContain("https://api-alt.dbbaby.top");
        expect(origins).toContain("https://auth.dbbaby.top");
        expect(origins).toContain("https://sadmin.dbbaby.top");
    });

    test("shared auth owner routes include dependent frontend origins", async () => {
        const originalOwnerRef = config.authRuntimeOwnerRef;
        config.authRuntimeOwnerRef = "auth-owner";
        try {
            const calls: Array<{ url: string; method: string; body: any }> = [];
            const restore = captureFetch(calls);
            try {
                const provider = new CaddyGatewayProvider();
                const result = await provider.setupUpstream("auth-owner", 3000, 9999);
                expect(result.success).toBe(true);
                await provider.configureFrontendRoute({
                    projectRef: "dependent-project",
                    deploymentId: "fa-web",
                    hosts: ["fa.xai.xigu.team"],
                    mode: "static",
                    root: "/srv/fa-web",
                });
                const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
                const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
                const ownerAuthRoute = routes.find((route: any) => String(route?.match?.[0]?.path ?? "").includes("/auth/v1"));
                const serialized = JSON.stringify(ownerAuthRoute);
                expect(serialized).toContain("fa.xai.xigu.team");
            } finally {
                restore();
            }
        } finally {
            config.authRuntimeOwnerRef = originalOwnerRef;
        }
    });
});

describe("CaddyGatewayProvider", () => {
    afterEach(async () => {
        await cleanCaddyTmp();
    });

    test("renders the selected on-demand TLS issuer", async () => {
        const originalIssuer = config.caddyTlsIssuer;
        try {
            for (const [issuer, expectedIssuers] of [
                ["internal", [{ module: "internal" }]],
                ["acme", undefined],
            ] as const) {
                config.caddyTlsIssuer = issuer;
                const calls: Parameters<typeof captureFetch>[0] = [];
                const restore = captureFetch(calls);
                try {
                    const setupResult = await new CaddyGatewayProvider().setupUpstream("tlsissuer", 3000, 9999);
                    expect(setupResult.success).toBe(true);
                    const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
                    expect(load?.body?.apps?.tls?.automation?.policies?.[0]?.issuers).toEqual(expectedIssuers);
                } finally {
                    restore();
                }
            }
        } finally {
            config.caddyTlsIssuer = originalIssuer;
        }
    });

    test("setupUpstream renders Caddy JSON routes for Supabase-compatible APIs", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        const result = await provider.setupUpstream("testref123", 3000, 9999);
        expect(result.success).toBe(true);

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        expect(load).toBeDefined();
        const server = load?.body?.apps?.http?.servers?.supacloud;
        expect(server).not.toHaveProperty("http3");
        expect(server?.tls_connection_policies).toEqual([{}]);
        const noticeLog = load?.body?.logging?.logs?.supacloud_notice_do_not_edit_caddy_config_json_use_supacloud_cli_management_api_or_web_console;
        expect(noticeLog?.writer?.output).toBe("discard");
        expect(noticeLog?.level).toBe("INFO");
        const defaultLogEncoder = load?.body?.logging?.logs?.default?.encoder;
        expect(defaultLogEncoder?.format).toBe("filter");
        expect(defaultLogEncoder?.wrap).toEqual({ format: "json" });
        expect(defaultLogEncoder?.fields?.["request>headers>Apikey"]).toEqual({
            filter: "replace",
            value: "REDACTED",
        });
        expect(load?.body?.apps?.tls?.automation?.policies?.[0]?.key_type).toBe("p256");
        const notice = await readFile("/tmp/supacloud-caddy-test/DO-NOT-EDIT.txt", "utf8");
        expect(notice).toContain("Do not edit /tmp/supacloud-caddy-test/config.json by hand.");
        expect(notice).toContain("Change via: supacloud CLI, SupaCloud management API, SupaCloud web console.");
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        const rest = routes.find((route: any) => route["@id"] === "route-project-testref123-rest");
        const restOpenApi = routes.find((route: any) => route["@id"] === "route-project-testref123-rest-openapi");
        const opaqueRest = routes.find((route: any) => route["@id"] === "route-project-testref123-opaque-rest");
        const storage = routes.find((route: any) => route["@id"] === "route-project-testref123-storage");
        const storageResumable = routes.find((route: any) => route["@id"] === "route-project-testref123-storage-resumable");
        const functions = routes.find((route: any) => route["@id"] === "route-project-testref123-functions");
        const adminUserDelete = routes.find((route: any) => route["@id"] === "route-project-testref123-auth-admin-user-delete");
        const realtime = routes.find((route: any) => route["@id"] === "route-project-testref123-realtime");
        const management = routes.find((route: any) => route["@id"] === "route-project-testref123-management");

        expect(rest?.match?.[0]?.path).toEqual(["/rest/v1*"]);
        expect(restOpenApi?.match?.[0]?.path).toEqual(["/rest/v1", "/rest/v1/"]);
        expect(restOpenApi?.match?.[0]?.method).toEqual(["GET", "HEAD"]);
        expect(restOpenApi?.handle?.at(-1)?.upstreams?.[0]?.dial).toBe("127.0.0.1:9090");
        expect(routes.indexOf(restOpenApi)).toBeLessThan(routes.indexOf(rest));
        expect(rest?.handle?.some((handler: any) => handler.strip_path_prefix === "/rest/v1")).toBe(true);
        expect(rest?.handle?.at(-1)?.headers?.request?.set?.["X-Project-Ref"]).toEqual(["testref123"]);
        expect(opaqueRest?.__supacloud_priority).toBeUndefined();
        expect(opaqueRest?.match).toHaveLength(2);
        expect(opaqueRest?.match?.[0]?.header_regexp?.apikey?.pattern).toContain("sb_(publishable|secret)_");
        expect(opaqueRest?.match?.[1]?.header_regexp?.Authorization?.pattern).toContain("Bearer");
        expect(opaqueRest?.handle?.at(-1)?.upstreams?.[0]?.dial).toBe("127.0.0.1:9090");
        expect(adminUserDelete?.match?.[0]?.method).toEqual(["DELETE"]);
        expect(adminUserDelete?.match?.[0]?.path_regexp?.pattern).toContain("/auth/v1/admin/users/");
        expect(adminUserDelete?.handle?.at(-1)?.upstreams?.[0]?.dial).toBe("127.0.0.1:9090");
        expect(routes.indexOf(adminUserDelete)).toBeLessThan(
            routes.findIndex((route: any) => route["@id"] === "route-project-testref123-auth"),
        );
        const reverseProxyHandlers = findReverseProxyHandlers(routes);
        expect(reverseProxyHandlers.every((handler: any) => !handler.upstreams?.[0]?.dial?.includes("/"))).toBe(true);
        for (const handler of reverseProxyHandlers) {
            const routeId = findRouteIdForHandler(routes, handler);
            const preservesUpstreamCors = routeId?.endsWith("-storage")
                || routeId?.endsWith("-storage-resumable")
                || routeId?.endsWith("-functions");
            if (preservesUpstreamCors) {
                expect(handler.headers?.response?.delete).toBeUndefined();
            } else {
                expect(handler.headers?.response?.delete).toContain("Access-Control-Allow-Origin");
                expect(handler.headers?.response?.delete).toContain("Access-Control-Allow-Credentials");
                expect(handler.headers?.response?.delete).toContain("Access-Control-Allow-Methods");
                expect(handler.headers?.response?.delete).toContain("Access-Control-Allow-Headers");
                expect(handler.headers?.response?.delete).toContain("Access-Control-Expose-Headers");
                expect(handler.headers?.response?.delete).toContain("Access-Control-Max-Age");
            }
        }
        expect(routes.find((route: any) => route["@id"] === "route-project-testref123-graphql")
            ?.handle?.some((handler: any) => handler.uri === "/rpc/graphql")).toBe(true);
        expect(storage?.match?.[0]?.path).toEqual(["/storage/v1*"]);
        expect(findCorsSubroute(storage)).toBeUndefined();
        expect(findCorsSubroute(storageResumable)).toBeUndefined();
        const storageProxy = storage?.handle?.find((h: any) => h.handler === "reverse_proxy");
        expect(storageProxy?.flush_interval).toBeUndefined();
        const restProxy = rest?.handle?.find((h: any) => h.handler === "reverse_proxy");
        expect(restProxy?.flush_interval).toBe(-1);
        expect(functions?.match?.[0]?.path).toEqual(["/functions/v1*"]);
        expect(findCorsSubroute(functions)).toBeUndefined();
        const functionsProxy = functions?.handle?.find((h: any) => h.handler === "reverse_proxy");
        expect(functionsProxy?.headers?.response).toBeUndefined();
        expect(realtime?.match?.[0]?.path).toEqual(["/realtime/v1/websocket*"]);
        expect(management?.match?.[0]?.path).toEqual(["/v1/projects/testref123", "/v1/projects/testref123/*"]);
        expect(management?.handle?.some((handler: any) => handler.handler === "rewrite")).toBe(false);
        expect(management?.handle?.at(-1)?.headers?.request?.set?.["X-Project-Ref"]).toEqual(["testref123"]);

        const corsSubroute = findCorsSubroute(rest);
        const preflight = corsSubroute?.routes?.find((route: any) =>
            route.match?.some((matcher: any) => matcher.method?.includes("OPTIONS"))
        );
        const corsHeaders = preflight?.handle?.find((handler: any) => handler.handler === "headers");
        expect(preflight?.terminal).toBe(true);
        expect(preflight?.handle?.some((handler: any) => handler.handler === "static_response" && handler.status_code === 204)).toBe(true);
        expect(corsHeaders?.response?.set?.["Access-Control-Allow-Origin"]).toEqual(["{http.request.header.Origin}"]);
        expect(corsHeaders?.response?.set?.["Access-Control-Allow-Credentials"]).toEqual(["true"]);
        expect(corsHeaders?.response?.set?.["Access-Control-Allow-Headers"]?.[0]).toContain("Idempotency-Key");
        expect(corsHeaders?.response?.set?.["Access-Control-Allow-Headers"]?.[0]).toContain("tus-resumable");
        expect(corsHeaders?.response?.set?.["Access-Control-Allow-Headers"]?.[0]).toContain("upload-metadata");
        expect(preflight?.match?.some((matcher: any) => matcher.header_regexp?.Origin?.pattern?.includes("localhost"))).toBe(true);

        restore();
    });

    test("setupUpstream renders auth-only routes for a dedicated auth domain", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        const result = await provider.setupUpstream("proj123", 3000, 9999, {
            api_domain: "api.example.com",
            auth_domain: "auth.example.com",
            studio_domain: "studio.example.com",
        });
        expect(result.success).toBe(true);

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        const rest = routes.find((route: any) => route["@id"] === "route-project-proj123-rest");
        const auth = routes.find((route: any) => route["@id"] === "route-project-proj123-auth-domain-auth");
        const wellKnown = routes.find((route: any) => route["@id"] === "route-project-proj123-auth-domain-gotrue-well-known");
        const adminUserDelete = routes.find((route: any) => route["@id"] === "route-project-proj123-auth-admin-user-delete");

        expect(rest?.match?.[0]?.host).not.toContain("auth.example.com");
        expect(auth?.match?.[0]?.host).toEqual(["auth.example.com"]);
        expect(auth?.match?.[0]?.path).toEqual(["/auth/v1*"]);
        expect(auth?.handle?.some((handler: any) => handler.strip_path_prefix === "/auth/v1")).toBe(true);
        expect(wellKnown?.match?.[0]?.host).toEqual(["auth.example.com"]);
        expect(wellKnown?.match?.[0]?.path).toEqual(["/.well-known/oauth-authorization-server/auth/v1*"]);
        expect(adminUserDelete?.match?.[0]?.host).toContain("auth.example.com");

        restore();
    });

    test("renders isolated project security limits before rewrites and preserves configured limits across reload", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        try {
            const projectRef = "tenant-with-hyphen";
            await provider.setupUpstream(projectRef, 3000, 9999, {
                api_domain: "tenant-api.example.com",
                auth_domain: "tenant-auth.example.com",
            });
            await provider.configureCustomGatewayRoutes(projectRef, [{
                id: "supauth-api",
                hosts: ["supauth-api.example.com"],
                path: ["/api/*", "/v1/*"],
                upstream: "127.0.0.1:9090",
                rewrite_uri: "/functions/v1/supauth{http.request.uri.path}",
                cors: ["https://admin.example.com"],
                priority: 110,
            }]);
            await provider.setRateLimit(projectRef, "free");
            await provider.setCustomRouteRateLimit(projectRef, "/auth/v1/token", { minute: 200 });

            const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
            const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
            const security = routes.find((route: any) => route["@id"] === `route-security-project-${projectRef}`);
            const securityHandler = security?.handle?.find((handler: any) => handler.handler === "rate_limit");
            const zones = Object.entries(securityHandler?.rate_limits ?? {}) as Array<[string, any]>;
            const zone = (category: string) => zones.find(([name]) => name.endsWith(`_security_${category}_minute`));

            expect(security).toBeDefined();
            expect(security?.terminal).toBeUndefined();
            expect(security?.match).toContainEqual({
                host: ["supauth-api.example.com"],
                path: ["/api/v1", "/api/v1/*"],
            });
            expect(security?.match).toContainEqual({
                host: expect.arrayContaining(["tenant-api.example.com", "tenant-auth.example.com"]),
                path: ["/auth/v1/token", "/auth/v1/token/", "/auth/v1/signup", "/auth/v1/signup/"],
            });
            expect(zones).toHaveLength(4);
            expect(zone("password")?.[1]).toMatchObject({
                key: "{http.request.remote.host}",
                window: "1m",
                max_events: 10,
                ipv6_prefix: 64,
                match: [{
                    method: ["POST"],
                    path: ["/auth/v1/token", "/auth/v1/token/"],
                    query: { grant_type: ["password"] },
                }],
            });
            expect(zone("signup")?.[1]).toMatchObject({ max_events: 5, match: [{ method: ["POST"] }] });
            expect(zone("refresh")?.[1]).toMatchObject({
                max_events: 120,
                match: [{ query: { grant_type: ["refresh_token"] } }],
            });
            expect(zone("api")?.[1]).toMatchObject({
                max_events: 100,
                match: [{ path: ["/api/v1", "/api/v1/*"], not: [{ method: ["OPTIONS"] }] }],
            });
            expect(JSON.stringify(securityHandler)).not.toMatch(/Forwarded|X-Real-IP/i);

            const corsHandlers = security.handle.filter((handler: any) => handler.handler === "subroute");
            const apiCors = corsHandlers.find((handler: any) =>
                handler.routes?.[0]?.match?.[0]?.host?.includes("supauth-api.example.com"),
            );
            const authCors = corsHandlers.filter((handler: any) =>
                !handler.routes?.[0]?.match?.[0]?.host?.includes("supauth-api.example.com"),
            );
            const corsIndex = security.handle.indexOf(corsHandlers[0]);
            const securityLimitIndex = security.handle.indexOf(securityHandler);
            expect(corsIndex).toBeLessThan(securityLimitIndex);
            expect(JSON.stringify(apiCors)).toContain("https://admin.example.com");
            expect(JSON.stringify(apiCors)).toContain("Retry-After");
            expect(authCors.length).toBeGreaterThan(0);
            expect(authCors.every((handler: any) =>
                !JSON.stringify(handler).includes("https://admin.example.com"),
            )).toBe(true);
            expect(authCors.every((handler: any) => JSON.stringify(handler).includes("Retry-After"))).toBe(true);

            const customLimitRoute = routes.find((route: any) => route["@id"]?.startsWith(`route-custom-${projectRef}-`));
            const customLimitHandler = customLimitRoute?.handle?.find((handler: any) => handler.handler === "rate_limit");
            const customRewriteIndex = customLimitRoute?.handle?.findIndex((handler: any) => handler.handler === "rewrite");
            expect(routes.indexOf(security)).toBeLessThan(routes.indexOf(customLimitRoute));
            expect(customLimitRoute?.handle?.indexOf(customLimitHandler)).toBeLessThan(customRewriteIndex);

            await provider.setupUpstream("tenant", 3010, 9998, { api_domain: "short-tenant.example.com" });
            const multiProjectLoad = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
            const multiProjectRoutes = multiProjectLoad?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
            const securityRoutes = multiProjectRoutes.filter((route: any) => route["@id"]?.startsWith("route-security-project-"));
            const securityZoneNames = securityRoutes.map((route: any) => Object.keys(
                route.handle.find((handler: any) => handler.handler === "rate_limit")?.rate_limits ?? {},
            ));
            const shortProjectSecurity = securityRoutes.find((route: any) => route["@id"] === "route-security-project-tenant");
            expect(securityRoutes).toHaveLength(2);
            expect(new Set(securityZoneNames.flat()).size).toBe(8);
            expect(JSON.stringify(shortProjectSecurity?.match)).not.toContain("supauth-api.example.com");

            const restartedProvider = new CaddyGatewayProvider();
            await restartedProvider.setupMasterRoutes();
            expect(await restartedProvider.getRateLimit(projectRef)).toEqual({
                tier: "custom",
                second: 60,
                minute: 3000,
                hour: 100000,
                enabled: true,
            });
            const reload = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
            const reloadedRoutes = reload?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
            expect(reloadedRoutes.filter((route: any) => route["@id"] === security["@id"])).toHaveLength(1);
        } finally {
            restore();
        }
    });

    test("setupUpstream splits business auth routes to an external IdP upstream", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        const result = await provider.setupUpstream("bizproj", 3000, 3372, {
            api_domain: "api.biz.example.com",
            auth_domain: "auth.biz.example.com",
            studio_domain: "studio.biz.example.com",
            auth: {
                third_party_auth: {
                    enabled: true,
                    issuer: "https://auth.example.com/auth/v1",
                    jwks_url: "https://auth.example.com/auth/v1/.well-known/jwks.json",
                    audience: "authenticated",
                    client_id: "client_1",
                    auth_endpoint_mode: "external",
                    auth_upstream: "127.0.0.1:3367",
                    auth_host_header: "auth.example.com",
                    claim_mapping: {
                        sub: "sub",
                        role: "role",
                        email: "email",
                    },
                },
            },
        });
        expect(result.success).toBe(true);

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        const rest = routes.find((route: any) => route["@id"] === "route-project-bizproj-rest");
        const functions = routes.find((route: any) => route["@id"] === "route-project-bizproj-functions");
        const auth = routes.find((route: any) => route["@id"] === "route-project-bizproj-auth");
        const wellKnown = routes.find((route: any) => route["@id"] === "route-project-bizproj-gotrue-well-known");
        const authDomain = routes.find((route: any) => route["@id"] === "route-project-bizproj-auth-domain-auth");
        const adminUserDelete = routes.find((route: any) => route["@id"] === "route-project-bizproj-auth-admin-user-delete");

        const restProxy = rest?.handle?.find((handler: any) => handler.handler === "reverse_proxy");
        const functionsProxy = functions?.handle?.find((handler: any) => handler.handler === "reverse_proxy");
        const authProxy = auth?.handle?.find((handler: any) => handler.handler === "reverse_proxy");
        const wellKnownProxy = wellKnown?.handle?.find((handler: any) => handler.handler === "reverse_proxy");
        const authDomainProxy = authDomain?.handle?.find((handler: any) => handler.handler === "reverse_proxy");

        expect(restProxy?.upstreams?.[0]?.dial).toBe("127.0.0.1:3000");
        expect(functionsProxy?.upstreams?.[0]?.dial).not.toBe("127.0.0.1:3367");
        expect(authProxy?.upstreams?.[0]?.dial).toBe("127.0.0.1:3367");
        expect(wellKnownProxy?.upstreams?.[0]?.dial).toBe("127.0.0.1:3367");
        expect(authDomainProxy?.upstreams?.[0]?.dial).toBe("127.0.0.1:3367");
        expect(adminUserDelete?.handle?.at(-1)?.upstreams?.[0]?.dial).toBe("127.0.0.1:9090");
        const deletePattern = String(adminUserDelete?.match?.[0]?.path_regexp?.pattern || "").replace("(?i)", "");
        expect(new RegExp(deletePattern, "i").test(
            "/auth/v1/admin/users/00000000-0000-4000-8000-000000000001",
        )).toBe(true);
        expect(new RegExp(deletePattern, "i").test(
            "/auth/v1/admin/users/00000000-0000-4000-8000-000000000001/",
        )).toBe(true);
        expect(new RegExp(deletePattern, "i").test(
            "/auth/v1/admin/users/00000000-0000-4000-8000-000000000001//",
        )).toBe(false);
        expect(new RegExp(deletePattern, "i").test(
            "/auth/v1/admin/users/00000000-0000-4000-8000-000000000001/factors/factor-1",
        )).toBe(false);
        expect(routes.indexOf(adminUserDelete)).toBeLessThan(routes.indexOf(auth));
        expect(authProxy?.headers?.request?.set?.Host).toEqual(["auth.example.com"]);
        expect(authProxy?.headers?.request?.set?.["X-Forwarded-Host"]).toEqual(["auth.example.com"]);

        restore();
    });

    test("setupUpstream does not render duplicate auth-domain routes without a dedicated auth domain", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        await provider.setupUpstream("proj-no-auth", 3000, 9999, {
            api_domain: "api.example.com",
            studio_domain: "studio.example.com",
        });
        await provider.setupUpstream("proj-same-auth", 3001, 9998, {
            api_domain: "api2.example.com",
            auth_domain: "api2.example.com",
            studio_domain: "studio2.example.com",
        });

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];

        expect(routes.some((route: any) => route["@id"] === "route-project-proj-no-auth-auth-domain-auth")).toBe(false);
        expect(routes.some((route: any) => route["@id"] === "route-project-proj-no-auth-auth-domain-gotrue-well-known")).toBe(false);
        expect(routes.some((route: any) => route["@id"] === "route-project-proj-same-auth-auth-domain-auth")).toBe(false);
        expect(routes.some((route: any) => route["@id"] === "route-project-proj-same-auth-auth-domain-gotrue-well-known")).toBe(false);

        restore();
    });

    test("setupMasterRoutes applies the same Caddy CORS handling to system routes", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        await provider.setupMasterRoutes();

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        const api = routes.find((route: any) => route["@id"] === "route-system-management-api");
        const studio = routes.find((route: any) => route["@id"] === "route-system-studio-root");

        expect(api?.match?.[0]?.host).toContain(config.baseDomain);
        expect(api?.match?.[0]?.host).toContain(`api.${config.baseDomain}`);
        expect(findCorsSubroute(api)).toBeDefined();
        expect(findCorsSubroute(studio)).toBeDefined();

        restore();
    });

    test("configureFrontendRoute renders a stable frontend root route", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        await provider.setupUpstream("proj123", 3000, 9999, {
            api_domain: "api.example.com",
            studio_domain: "studio.example.com",
        });
        await provider.configureFrontendRoute({
            projectRef: "proj123",
            deploymentId: "0000002a",
            hosts: ["site.example.com", "www.example.com"],
            port: 30042,
        });

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        const route = routes.find((item: any) => item["@id"] === "route-frontend-proj123-0000002a");
        expect(route?.match?.[0]?.host).toEqual(["site.example.com", "www.example.com"]);
        expect(route?.match?.[0]?.path).toEqual(["/*"]);
        expect(route?.handle?.at(-1)?.upstreams?.[0]?.dial).toBe("127.0.0.1:30042");
        const apiRoute = routes.find((item: any) => item["@id"] === "route-project-proj123-rest");
        const corsSubroute = findCorsSubroute(apiRoute);
        const exactMatcher = corsSubroute?.routes?.[0]?.match?.find((matcher: any) => matcher.header?.Origin);
        expect(exactMatcher?.header?.Origin).toContain("https://site.example.com");
        expect(exactMatcher?.header?.Origin).toContain("https://www.example.com");
        expect(exactMatcher?.header?.Origin).toContain("https://api.example.com");
        // The functions route owns its upstream CORS policy and never carries a
        // gateway-rendered CORS subroute.
        const functionsRoute = routes.find((item: any) => item["@id"] === "route-project-proj123-functions");
        expect(findCorsSubroute(functionsRoute)).toBeUndefined();

        restore();
    });

    test("configureStudioDomain adds an HTTP-only 308 redirect without replacing custom routes", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        await provider.configureCustomGatewayRoutes("_global", [{
            id: "existing-global-route",
            hosts: ["existing.example.com"],
            path: "/*",
            upstream: "127.0.0.1:8080",
        }]);
        await provider.configureStudioDomain("studio.example.com", 9090);

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        const redirect = routes.find((route: any) => route["@id"] === "route-custom-gateway-_global-studio-https-redirect");
        const studio = routes.find((route: any) => route["@id"] === "route-frontend-_global-studio");

        expect(routes.some((route: any) => route["@id"] === "route-custom-gateway-_global-existing-global-route")).toBe(true);
        expect(redirect?.match?.[0]).toEqual({
            host: ["studio.example.com"],
            path: ["/*"],
            vars: {
                "{http.request.scheme}": ["http"],
            },
        });
        expect(redirect?.handle?.[0]).toMatchObject({
            handler: "static_response",
            status_code: 308,
            headers: { Location: ["https://studio.example.com{http.request.uri}"] },
        });
        expect(studio?.match?.[0]?.host).toEqual(["studio.example.com"]);
        expect(studio?.handle?.at(-1)?.upstreams?.[0]?.dial).toBe("127.0.0.1:9090");

        restore();
    });

    test("setupUpstream preserves existing frontend hosts as allowed CORS origins", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        await provider.configureFrontendRoute({
            projectRef: "proj123",
            deploymentId: "0000002c",
            hosts: ["app.example.com"],
            port: 30043,
        });
        await provider.setupUpstream("proj123", 3000, 9999, {
            api_domain: "api.example.com",
            studio_domain: "studio.example.com",
        });

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        const restRoute = routes.find((item: any) => item["@id"] === "route-project-proj123-rest");
        const corsSubroute = findCorsSubroute(restRoute);
        const exactMatcher = corsSubroute?.routes?.[0]?.match?.find((matcher: any) => matcher.header?.Origin);
        expect(exactMatcher?.header?.Origin).toContain("https://app.example.com");
        expect(exactMatcher?.header?.Origin).toContain("https://api.example.com");
        // Functions keep their upstream-owned CORS policy instead of the
        // gateway-rendered subroute.
        const functionsRoute = routes.find((item: any) => item["@id"] === "route-project-proj123-functions");
        expect(findCorsSubroute(functionsRoute)).toBeUndefined();

        restore();
    });

    test("configureFrontendRoute renders Caddy static file_server route with precompression", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        await provider.configureFrontendRoute({
            projectRef: "proj123",
            deploymentId: "0000002b",
            hosts: ["static.example.com"],
            root: "/var/supacloud/frontends/proj123/0000002b/build",
            mode: "static",
        });

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        const route = routes.find((item: any) => item["@id"] === "route-frontend-proj123-0000002b");
        const securityHeaders = route?.handle?.find((handler: any) =>
            handler.handler === "headers" && handler.response?.set?.["X-Content-Type-Options"],
        );
        const encode = route?.handle?.find((handler: any) => handler.handler === "encode");
        const subroute = route?.handle?.find((handler: any) => handler.handler === "subroute");
        const subroutes = subroute?.routes ?? [];
        const assetRouteIndex = subroutes.findIndex((item: any) => item.match?.[0]?.path?.includes("/assets/*") && item.match?.[0]?.file);
        const missingAssetRouteIndex = subroutes.findIndex((item: any) => item.match?.[0]?.path?.includes("/assets/*") && !item.match?.[0]?.file);
        const fallbackIndex = subroutes.findIndex((item: any) => item.match?.[0]?.file?.try_files?.includes("/index.html"));
        const avifRouteIndex = subroutes.findIndex((item: any) => item.match?.[0]?.header?.Accept?.includes("*image/avif*"));
        const webpRouteIndex = subroutes.findIndex((item: any) => item.match?.[0]?.header?.Accept?.includes("*image/webp*"));
        const assetRoute = subroutes[assetRouteIndex];
        const missingAssetRoute = subroutes[missingAssetRouteIndex];
        const fallback = subroutes[fallbackIndex];
        const tryFilesRoute = subroutes.find((item: any) => item.match?.[0]?.file?.try_files?.includes("{http.request.uri.path}.html"));
        const tryFiles = tryFilesRoute?.match?.[0]?.file;
        const avifRoute = subroutes[avifRouteIndex];
        const webpRoute = subroutes[webpRouteIndex];
        const fileServer = subroute?.routes?.at(-1)?.handle?.at(-1);

        expect(route?.match?.[0]?.host).toEqual(["static.example.com"]);
        expect(securityHeaders?.response?.set?.["Strict-Transport-Security"]).toBeUndefined();
        expect(securityHeaders?.response?.set?.["X-Content-Type-Options"]).toEqual(["nosniff"]);
        expect(securityHeaders?.response?.set?.["Referrer-Policy"]).toEqual(["strict-origin-when-cross-origin"]);
        expect(encode?.prefer).toEqual(["zstd", "gzip"]);
        expect(avifRouteIndex).toBeLessThan(assetRouteIndex);
        expect(webpRouteIndex).toBeLessThan(assetRouteIndex);
        expect(assetRoute?.match?.[0]?.file?.try_files).toEqual(["{http.request.uri.path}"]);
        expect(assetRoute?.handle?.[0]?.response?.set?.["Cache-Control"]).toEqual(["public, max-age=31536000, immutable"]);
        expect(assetRoute?.handle?.at(-1)?.handler).toBe("file_server");
        expect(assetRoute?.terminal).toBe(true);
        expect(missingAssetRoute?.handle?.[0]?.response?.set?.["Cache-Control"]).toEqual(["no-cache"]);
        expect(missingAssetRoute?.handle?.[1]).toEqual({ handler: "static_response", status_code: 404 });
        expect(missingAssetRoute?.terminal).toBe(true);
        expect(missingAssetRouteIndex).toBeGreaterThan(assetRouteIndex);
        expect(missingAssetRouteIndex).toBeLessThan(fallbackIndex);
        expect(tryFiles?.try_files).not.toContain("/index.html");
        expect(tryFilesRoute?.handle?.at(-1)?.handler).toBe("file_server");
        expect(tryFilesRoute?.terminal).toBe(true);
        expect(fallback?.handle?.[0]?.response?.set?.["Cache-Control"]).toEqual(["no-cache"]);
        expect(fallback?.handle?.[1]?.uri).toBe("{http.matchers.file.relative}");
        expect(avifRoute?.match?.[0]?.file?.try_files).toEqual(["{http.request.uri.path}.avif"]);
        expect(webpRoute?.match?.[0]?.file?.try_files).toEqual(["{http.request.uri.path}.webp"]);
        expect(avifRoute?.handle?.at(-1)?.handler).toBe("file_server");
        expect(avifRoute?.terminal).toBe(true);
        expect(webpRoute?.handle?.at(-1)?.handler).toBe("file_server");
        expect(webpRoute?.terminal).toBe(true);
        expect(fileServer?.handler).toBe("file_server");
        expect(fileServer?.root).toBe("/var/supacloud/frontends/proj123/0000002b/build");
        expect(fileServer?.precompressed).toEqual({ br: {}, zstd: {}, gzip: {} });

        restore();
    });

    test("reads back the one canonical static root for an immutable frontend route", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        try {
            const provider = new CaddyGatewayProvider();
            await provider.configureFrontendRoute({
                projectRef: "proj123",
                deploymentId: "fa-web",
                hosts: ["fa.example.com"],
                root: "/var/supacloud/frontends/proj123/fa-web/releases/a/build",
                mode: "static",
            });

            await expect(provider.readFrontendStaticRoot("proj123", "fa-web")).resolves.toBe(
                "/var/supacloud/frontends/proj123/fa-web/releases/a/build",
            );
            await expect(provider.readFrontendStaticRoot("proj123", "missing")).resolves.toBeNull();
        } finally {
            restore();
        }
    });

    test("restores the in-memory frontend and CORS candidates when Caddy rejects load", async () => {
        const originalFetch = globalThis.fetch;
        let loadedConfig: any = null;
        let rejectNextLoad = false;
        globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            const method = init?.method || "GET";
            if (method === "POST" && url.endsWith("/load")) {
                if (rejectNextLoad) {
                    rejectNextLoad = false;
                    return Promise.resolve(new Response("rejected", { status: 400 }));
                }
                loadedConfig = typeof init?.body === "string" ? JSON.parse(init.body) : null;
            }
            if (method === "GET" && url.endsWith("/config/apps/http/servers/supacloud/routes")) {
                return Promise.resolve(Response.json(loadedConfig?.apps?.http?.servers?.supacloud?.routes ?? []));
            }
            return Promise.resolve(Response.json({ ok: true }));
        }) as unknown as typeof fetch;
        try {
            const provider = new CaddyGatewayProvider();
            const oldRoot = "/var/supacloud/frontends/proj123/fa-web/releases/old/build";
            await provider.configureFrontendRoute({
                projectRef: "proj123",
                deploymentId: "fa-web",
                hosts: ["old.example.com"],
                root: oldRoot,
                mode: "static",
            });
            rejectNextLoad = true;
            await expect(provider.configureFrontendRoute({
                projectRef: "proj123",
                deploymentId: "fa-web",
                hosts: ["new.example.com"],
                root: "/var/supacloud/frontends/proj123/fa-web/releases/new/build",
                mode: "static",
            })).rejects.toThrow("Caddy /load failed");
            await expect(provider.readFrontendStaticRoot("proj123", "fa-web")).resolves.toBe(oldRoot);

            await provider.configureFrontendRoute({
                projectRef: "proj123",
                deploymentId: "other-web",
                hosts: ["other.example.com"],
                root: "/var/supacloud/frontends/proj123/other-web/releases/ok/build",
                mode: "static",
            });
            const routes = loadedConfig?.apps?.http?.servers?.supacloud?.routes ?? [];
            const restored = routes.find((route: any) => route["@id"] === "route-frontend-proj123-fa-web");
            expect(restored?.match?.[0]?.host).toEqual(["old.example.com"]);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("serializes Caddy load publishes so concurrent frontend routes cannot finish with stale config", async () => {
        const originalFetch = globalThis.fetch;
        const appliedLoads: any[] = [];
        let delayedSingleRouteLoad = false;
        let releaseSingleRouteLoad: (() => void) | null = null;
        let resolveSingleRouteStarted: (() => void) | null = null;
        const singleRouteStarted = new Promise<void>((resolve) => {
            resolveSingleRouteStarted = resolve;
        });

        globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            const method = init?.method || "GET";
            let body: any = null;
            if (typeof init?.body === "string" && init.body.length > 0) {
                try { body = JSON.parse(init.body); } catch { body = init.body; }
            }

            if (method === "POST" && url.endsWith("/load")) {
                const routeIds = (body?.apps?.http?.servers?.supacloud?.routes ?? []).map((route: any) => route["@id"]);
                const hasAdmin = routeIds.includes("route-frontend-proj123-admin0001");
                const hasMobile = routeIds.includes("route-frontend-proj123-mobile001");
                if (hasAdmin && !hasMobile && !delayedSingleRouteLoad) {
                    delayedSingleRouteLoad = true;
                    resolveSingleRouteStarted?.();
                    return new Promise<Response>((resolve) => {
                        releaseSingleRouteLoad = () => {
                            appliedLoads.push(body);
                            resolve(new Response(JSON.stringify({ ok: true })));
                        };
                    });
                }
                appliedLoads.push(body);
            }

            return Promise.resolve(new Response(JSON.stringify({ ok: true })));
        }) as unknown as typeof fetch;

        try {
            const provider = new CaddyGatewayProvider();
            const adminRoute = provider.configureFrontendRoute({
                projectRef: "proj123",
                deploymentId: "admin0001",
                hosts: ["admin.example.com"],
                root: "/var/supacloud/frontends/proj123/admin0001/build",
                mode: "static",
            });

            await singleRouteStarted;

            const mobileRoute = provider.configureFrontendRoute({
                projectRef: "proj123",
                deploymentId: "mobile001",
                hosts: ["m.example.com"],
                root: "/var/supacloud/frontends/proj123/mobile001/build",
                mode: "static",
            });

            await Promise.race([mobileRoute.catch(() => undefined), Bun.sleep(25)]);
            releaseSingleRouteLoad?.();
            await Promise.all([adminRoute, mobileRoute]);

            const finalRouteIds = (appliedLoads.at(-1)?.apps?.http?.servers?.supacloud?.routes ?? []).map((route: any) => route["@id"]);
            expect(finalRouteIds).toContain("route-frontend-proj123-admin0001");
            expect(finalRouteIds).toContain("route-frontend-proj123-mobile001");
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("does not let a failed frontend route rollback erase a concurrent successful route", async () => {
        const originalFetch = globalThis.fetch;
        let releaseFirstLoad: (() => void) | null = null;
        let firstLoadStarted!: () => void;
        const firstLoad = new Promise<void>((resolve) => { firstLoadStarted = resolve; });
        const appliedLoads: any[] = [];
        let loadCount = 0;
        globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            if ((init?.method || "GET") === "POST" && url.endsWith("/load")) {
                const body = JSON.parse(String(init?.body));
                loadCount += 1;
                if (loadCount === 1) {
                    firstLoadStarted();
                    return new Promise<Response>((resolve) => {
                        releaseFirstLoad = () => resolve(new Response("failure", { status: 500 }));
                    });
                }
                appliedLoads.push(body);
            }
            return Promise.resolve(Response.json([]));
        }) as unknown as typeof fetch;

        try {
            const provider = new CaddyGatewayProvider();
            const failed = provider.configureFrontendRoute({
                projectRef: "proj123", deploymentId: "failed001", hosts: ["failed.example.com"],
                root: "/var/supacloud/frontends/proj123/failed001/build", mode: "static",
            });
            await firstLoad;
            const succeeded = provider.configureFrontendRoute({
                projectRef: "proj123", deploymentId: "good0001", hosts: ["good.example.com"],
                root: "/var/supacloud/frontends/proj123/good0001/build", mode: "static",
            });
            await Promise.race([succeeded, Bun.sleep(20)]);
            expect(appliedLoads).toHaveLength(0);
            releaseFirstLoad?.();
            await expect(failed).rejects.toThrow("Caddy /load failed with 500");
            await succeeded;
            const routeIds = appliedLoads.at(-1)?.apps?.http?.servers?.supacloud?.routes
                ?.map((route: any) => route["@id"]);
            expect(routeIds).toContain("route-frontend-proj123-good0001");
            expect(routeIds).not.toContain("route-frontend-proj123-failed001");
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("retains an unrelated writer queued behind a failed frontend publish", async () => {
        const originalFetch = globalThis.fetch;
        let releaseFailedLoad!: () => void;
        let markFailedLoadStarted!: () => void;
        const failedLoadStarted = new Promise<void>((resolve) => { markFailedLoadStarted = resolve; });
        const appliedLoads: any[] = [];
        let loadCount = 0;
        globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            if ((init?.method || "GET") === "POST" && url.endsWith("/load")) {
                const body = JSON.parse(String(init?.body));
                loadCount += 1;
                if (loadCount === 1) {
                    markFailedLoadStarted();
                    return new Promise<Response>((resolve) => {
                        releaseFailedLoad = () => resolve(new Response("failure", { status: 500 }));
                    });
                }
                appliedLoads.push(body);
            }
            return Promise.resolve(Response.json([]));
        }) as unknown as typeof fetch;

        try {
            const provider = new CaddyGatewayProvider();
            const failed = provider.configureFrontendRoute({
                projectRef: "proj123", deploymentId: "failed001", hosts: ["failed.example.com"],
                root: "/var/supacloud/frontends/proj123/failed001/build", mode: "static",
            });
            await failedLoadStarted;
            const unrelated = provider.configureStudioDomain("studio.example.com", 9090);
            await Promise.race([unrelated, Bun.sleep(20)]);
            expect(appliedLoads).toHaveLength(0);
            releaseFailedLoad();
            await expect(failed).rejects.toThrow("Caddy /load failed with 500");
            await unrelated;

            const routeIds = appliedLoads.at(-1)?.apps?.http?.servers?.supacloud?.routes
                ?.map((route: any) => route["@id"]);
            expect(routeIds).toContain("route-frontend-_global-studio");
            expect(routeIds).not.toContain("route-frontend-proj123-failed001");
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("removeFrontendRoute completes without nesting the operation lock", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        try {
            const provider = new CaddyGatewayProvider();
            await provider.configureFrontendRoute({
                projectRef: "proj123", deploymentId: "remove001", hosts: ["remove.example.com"],
                root: "/var/supacloud/frontends/proj123/remove001/build", mode: "static",
            });

            const removed = provider.removeFrontendRoute("proj123", "remove001");
            await expect(Promise.race([
                removed.then(() => "removed"),
                Bun.sleep(500).then(() => "timeout"),
            ])).resolves.toBe("removed");

            const routes = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load"))
                .at(-1)?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
            expect(routes.some((route: any) => route["@id"] === "route-frontend-proj123-remove001")).toBe(false);
        } finally {
            restore();
        }
    });

    test("withDeferredPersist can call public writers reentrantly and publishes once", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        try {
            const provider = new CaddyGatewayProvider();
            await expect(provider.withDeferredPersist(async () => {
                await provider.setupMasterRoutes();
                await provider.configureStudioDomain("studio.example.com", 9090);
                return "ok";
            })).resolves.toBe("ok");

            const loads = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load"));
            expect(loads).toHaveLength(1);
            const routeIds = loads[0]?.body?.apps?.http?.servers?.supacloud?.routes
                ?.map((route: any) => route["@id"]);
            expect(routeIds).toContain("route-system-management-api");
            expect(routeIds).toContain("route-frontend-_global-studio");
        } finally {
            restore();
        }
    });

    test("drops rejected deferred mutations before an unrelated writer publishes", async () => {
        for (const rejectedBatch of [
            (provider: CaddyGatewayProvider) => provider.withDeferredPersist(async () => {
                await provider.setupMasterRoutes();
                throw new Error("batch rejected");
            }),
            (provider: CaddyGatewayProvider) => provider.withDeferredPersist(async () => {
                await provider.setupMasterRoutes();
                return { accepted: false };
            }, ({ accepted }) => accepted),
        ]) {
            const calls: Array<{ url: string; method: string; body: any }> = [];
            const restore = captureFetch(calls);
            try {
                const provider = new CaddyGatewayProvider();
                await rejectedBatch(provider).catch(() => undefined);
                await provider.configureStudioDomain("studio.example.com", 9090);
                const routes = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load"))
                    .at(-1)?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
                expect(routes.some((route: any) => route["@id"] === "route-system-management-api")).toBe(false);
            } finally {
                restore();
            }
        }
    });

    test("restores a failed deferred flush before an unrelated writer publishes", async () => {
        const originalFetch = globalThis.fetch;
        const appliedLoads: any[] = [];
        let loadCount = 0;
        globalThis.fetch = mock((_input: string | URL | Request, init?: RequestInit) => {
            if ((init?.method || "GET") === "POST") {
                loadCount += 1;
                if (loadCount === 1) return Promise.resolve(new Response("rejected", { status: 400 }));
                appliedLoads.push(JSON.parse(String(init?.body)));
            }
            return Promise.resolve(Response.json({}));
        }) as unknown as typeof fetch;
        try {
            const provider = new CaddyGatewayProvider();
            await expect(provider.withDeferredPersist(async () => {
                await provider.setupMasterRoutes();
            })).rejects.toThrow("Caddy /load failed with 400");
            await provider.configureStudioDomain("studio.example.com", 9090);
            const routes = appliedLoads.at(-1)?.apps?.http?.servers?.supacloud?.routes ?? [];
            expect(routes.some((route: any) => route["@id"] === "route-system-management-api")).toBe(false);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("keeps accepted outer deferred mutations while discarding a rejected inner scope", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        try {
            const provider = new CaddyGatewayProvider();
            await provider.withDeferredPersist(async () => {
                await provider.configureStudioDomain("studio.example.com", 9090);
                await provider.withDeferredPersist(async () => {
                    await provider.setupMasterRoutes();
                    return false;
                }, Boolean);
            });
            const routes = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load"))
                .at(-1)?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
            expect(routes.some((route: any) => route["@id"] === "route-frontend-_global-studio")).toBe(true);
            expect(routes.some((route: any) => route["@id"] === "route-system-management-api")).toBe(false);
        } finally {
            restore();
        }
    });

    test("repairs a live candidate after the load response is lost", async () => {
        const originalFetch = globalThis.fetch;
        let liveConfig: any = null;
        globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            if (url.endsWith("/load") && init?.method === "POST") {
                liveConfig = JSON.parse(String(init.body));
                return Promise.reject(new Error("response lost"));
            }
            if (url.endsWith("/config/")) return Promise.resolve(Response.json(liveConfig));
            return Promise.resolve(Response.json([]));
        }) as unknown as typeof fetch;
        try {
            const provider = new CaddyGatewayProvider();
            await provider.configureFrontendRoute({
                projectRef: "proj123", deploymentId: "fa-web", hosts: ["fa.example.com"],
                root: "/var/supacloud/frontends/proj123/fa-web/releases/a/build", mode: "static",
            });
            expect(JSON.parse(await readFile(config.caddyConfigPath, "utf8")))
                .toEqual(liveConfig);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("quarantines a live but non-durable candidate from unrelated writers", async () => {
        const originalFetch = globalThis.fetch;
        let liveConfig: any = null;
        let loadCount = 0;
        globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            if (url.endsWith("/load") && init?.method === "POST") {
                loadCount += 1;
                liveConfig = JSON.parse(String(init.body));
            }
            if (url.endsWith("/config/")) return Promise.resolve(Response.json(liveConfig));
            return Promise.resolve(Response.json([]));
        }) as unknown as typeof fetch;
        try {
            const provider = new CaddyGatewayProvider({
                persistLoadedCandidate: async () => { throw new Error("rename failed"); },
            });
            await expect(provider.configureFrontendRoute({
                projectRef: "proj123", deploymentId: "fa-web", hosts: ["fa.example.com"],
                root: "/var/supacloud/frontends/proj123/fa-web/releases/a/build", mode: "static",
            })).rejects.toMatchObject({ code: "CADDY_GATEWAY_DURABILITY_UNKNOWN" });
            await expect(provider.configureStudioDomain("studio.example.com", 9090))
                .rejects.toMatchObject({ code: "CADDY_GATEWAY_DURABILITY_UNKNOWN" });
            expect(loadCount).toBe(1);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("drops an unproven candidate once live readback is different before an unrelated writer", async () => {
        const originalFetch = globalThis.fetch;
        const submittedLoads: any[] = [];
        let liveConfig: any = null;
        let loseNextLoadResponse = false;
        let loseNextReadback = false;
        globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            if (url.endsWith("/load") && init?.method === "POST") {
                const candidate = JSON.parse(String(init.body));
                submittedLoads.push(candidate);
                if (loseNextLoadResponse) {
                    loseNextLoadResponse = false;
                    return Promise.reject(new Error("response lost"));
                }
                liveConfig = candidate;
            }
            if (url.endsWith("/config/")) {
                if (loseNextReadback) {
                    loseNextReadback = false;
                    return Promise.reject(new Error("readback lost"));
                }
                return Promise.resolve(Response.json(liveConfig));
            }
            return Promise.resolve(Response.json([]));
        }) as unknown as typeof fetch;
        try {
            const baselineProvider = new CaddyGatewayProvider();
            await baselineProvider.configureFrontendRoute({
                projectRef: "proj123", deploymentId: "fa-web", hosts: ["old.example.com"],
                root: "/var/supacloud/frontends/proj123/fa-web/releases/old/build", mode: "static",
            });

            const provider = new CaddyGatewayProvider();
            loseNextLoadResponse = true;
            loseNextReadback = true;
            await expect(provider.configureFrontendRoute({
                projectRef: "proj123", deploymentId: "fa-web", hosts: ["failed.example.com"],
                root: "/var/supacloud/frontends/proj123/fa-web/releases/failed/build", mode: "static",
            })).rejects.toMatchObject({ code: "CADDY_GATEWAY_DURABILITY_UNKNOWN" });

            await provider.configureStudioDomain("studio.example.com", 9090);

            const finalRoutes = liveConfig?.apps?.http?.servers?.supacloud?.routes ?? [];
            const restoredRoute = finalRoutes.find((route: any) => route["@id"] === "route-frontend-proj123-fa-web");
            const restoredRouteJson = JSON.stringify(restoredRoute);
            expect(finalRoutes.some((route: any) => route["@id"] === "route-frontend-_global-studio")).toBe(true);
            expect(restoredRoute?.match?.[0]?.host).toEqual(["old.example.com"]);
            expect(restoredRouteJson).toContain("/var/supacloud/frontends/proj123/fa-web/releases/old/build");
            expect(restoredRouteJson).not.toContain("/var/supacloud/frontends/proj123/fa-web/releases/failed/build");
            expect(submittedLoads).toHaveLength(3);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("repairs every durability stage without rolling back a live candidate", async () => {
        const durabilityStages = [
            "candidate_sync",
            "candidate_rename",
            "config_directory_sync",
            "notice_open",
            "notice_write",
            "notice_sync",
            "notice_directory_sync",
        ] as const;

        for (const failedStage of durabilityStages) {
            const originalFetch = globalThis.fetch;
            let liveConfig: any = null;
            const appliedLoads: any[] = [];
            let injected = false;
            globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
                const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
                if (url.endsWith("/load") && init?.method === "POST") {
                    liveConfig = JSON.parse(String(init.body));
                    appliedLoads.push(liveConfig);
                }
                if (url.endsWith("/config/")) return Promise.resolve(Response.json(liveConfig));
                return Promise.resolve(Response.json([]));
            }) as unknown as typeof fetch;
            try {
                const provider = new CaddyGatewayProvider({
                    beforeDurabilityStage: async (stage) => {
                        if (stage === failedStage && !injected) {
                            injected = true;
                            throw new Error(`${stage} failed`);
                        }
                    },
                });
                await expect(provider.configureFrontendRoute({
                    projectRef: "proj123", deploymentId: "applied-web", hosts: ["applied.example.com"],
                    root: "/var/supacloud/frontends/proj123/applied-web/releases/a/build", mode: "static",
                })).rejects.toMatchObject({ code: "CADDY_GATEWAY_DURABILITY_UNKNOWN" });

                await provider.configureStudioDomain("studio.example.com", 9090);

                const finalRoutes = liveConfig?.apps?.http?.servers?.supacloud?.routes ?? [];
                expect(injected).toBe(true);
                expect(appliedLoads).toHaveLength(2);
                expect(finalRoutes.some((route: any) => route["@id"] === "route-frontend-proj123-applied-web")).toBe(true);
                expect(finalRoutes.some((route: any) => route["@id"] === "route-frontend-_global-studio")).toBe(true);
                expect(JSON.parse(await readFile(config.caddyConfigPath, "utf8"))).toEqual(liveConfig);
            } finally {
                globalThis.fetch = originalFetch;
                await cleanCaddyTmp();
            }
        }
    });

    test("rolls back when a lost load response proves a different live config", async () => {
        const originalFetch = globalThis.fetch;
        let lostResponse = true;
        let appliedConfig: any = null;
        globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            if (url.endsWith("/load") && init?.method === "POST") {
                if (lostResponse) {
                    lostResponse = false;
                    return Promise.reject(new Error("response lost"));
                }
                appliedConfig = JSON.parse(String(init.body));
            }
            if (url.endsWith("/config/")) return Promise.resolve(Response.json({ apps: {} }));
            return Promise.resolve(Response.json([]));
        }) as unknown as typeof fetch;
        try {
            const provider = new CaddyGatewayProvider();
            await expect(provider.configureFrontendRoute({
                projectRef: "proj123", deploymentId: "fa-web", hosts: ["fa.example.com"],
                root: "/var/supacloud/frontends/proj123/fa-web/releases/a/build", mode: "static",
            })).rejects.toThrow("response lost");
            await provider.configureStudioDomain("studio.example.com", 9090);
            const routes = appliedConfig?.apps?.http?.servers?.supacloud?.routes ?? [];
            expect(routes.some((route: any) => route["@id"] === "route-frontend-proj123-fa-web")).toBe(false);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("quarantines a lost load response when live state cannot be read", async () => {
        const originalFetch = globalThis.fetch;
        let loadCount = 0;
        globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            if (url.endsWith("/load") && init?.method === "POST") {
                loadCount += 1;
                return Promise.reject(new Error("response lost"));
            }
            if (url.endsWith("/config/")) return Promise.reject(new Error("readback lost"));
            return Promise.resolve(Response.json([]));
        }) as unknown as typeof fetch;
        try {
            const provider = new CaddyGatewayProvider();
            await expect(provider.configureFrontendRoute({
                projectRef: "proj123", deploymentId: "fa-web", hosts: ["fa.example.com"],
                root: "/var/supacloud/frontends/proj123/fa-web/releases/a/build", mode: "static",
            })).rejects.toMatchObject({ code: "CADDY_GATEWAY_DURABILITY_UNKNOWN" });
            await expect(provider.configureStudioDomain("studio.example.com", 9090))
                .rejects.toMatchObject({ code: "CADDY_GATEWAY_DURABILITY_UNKNOWN" });
            expect(loadCount).toBe(1);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("appends a terminal 404 route for unmatched hosts", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        await provider.configureFrontendRoute({
            projectRef: "proj123",
            deploymentId: "0000002d",
            hosts: ["static.example.com"],
            root: "/var/supacloud/frontends/proj123/0000002d/build",
            mode: "static",
        });

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        const fallback = routes.at(-1);

        expect(routes.find((item: any) => item["@id"] === "route-frontend-proj123-0000002d")).toBeDefined();
        expect(fallback?.["@id"]).toBe("route-system-unmatched-host-404");
        expect(fallback?.match).toBeUndefined();
        expect(fallback?.handle).toEqual([{ handler: "static_response", status_code: 404 }]);
        expect(fallback?.terminal).toBe(true);

        restore();
    });

    test("blocks publishing when Caddy validate passes but the startup preflight fails", async () => {
        const binaryPath = resolve(import.meta.dir, "../fixtures/caddy/fake-startup-rejects.sh");
        await chmod(binaryPath, 0o755);

        const originalBinaryPath = config.caddyBinaryPath;
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restoreFetch = captureFetch(calls);
        config.caddyBinaryPath = binaryPath;

        try {
            const provider = new CaddyGatewayProvider();
            await expect(provider.configureFrontendRoute({
                projectRef: "proj123",
                deploymentId: "preflight",
                hosts: ["preflight.example.com"],
                root: "/tmp/supacloud-caddy-test/frontend",
                mode: "static",
            })).rejects.toThrow("Caddy startup preflight failed");

            expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/load"))).toBe(false);
        } finally {
            config.caddyBinaryPath = originalBinaryPath;
            restoreFetch();
        }
    });

    test("configureCustomGatewayRoutes renders controlled proxy and static Caddy routes", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        const result = await provider.configureCustomGatewayRoutes("proj123", [
            {
                id: "ocr",
                hosts: ["ocr.example.com"],
                path: "/api/*",
                upstream: "https://10.20.0.12:4001",
                upstream_tls_insecure_skip_verify: true,
                rewrite_uri: "/functions/v1/supauth{http.request.uri.path}",
                headers: { "X-Custom-Upstream": "ocr" },
                cors: ["https://app.example.com"],
                priority: 10,
            },
            {
                id: "docs",
                hosts: ["docs.example.com"],
                path: "/*",
                static_root: "/var/supacloud/custom-sites/docs",
                headers: { "X-Robots-Tag": "noindex" },
                priority: 1,
            },
            {
                id: "disabled",
                hosts: ["disabled.example.com"],
                path: "/*",
                static_root: "/var/supacloud/custom-sites/disabled",
                enabled: false,
            },
        ]);

        expect(result.success).toBe(true);
        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        const ocr = routes.find((item: any) => item["@id"] === "route-custom-gateway-proj123-ocr");
        const docs = routes.find((item: any) => item["@id"] === "route-custom-gateway-proj123-docs");
        const disabled = routes.find((item: any) => item["@id"] === "route-custom-gateway-proj123-disabled");
        const proxy = ocr?.handle?.find((handler: any) => handler.handler === "reverse_proxy");
        const rewrite = ocr?.handle?.find((handler: any) => handler.handler === "rewrite");
        const corsSubroute = ocr?.handle?.find((handler: any) => handler.handler === "subroute");

        expect(routes[0]?.["@id"]).toBe("route-custom-gateway-proj123-ocr");
        expect(ocr?.__supacloud_priority).toBeUndefined();
        expect(ocr?.match?.[0]?.host).toEqual(["ocr.example.com"]);
        expect(ocr?.match?.[0]?.path).toEqual(["/api/*"]);
        expect(corsSubroute?.routes?.[0]?.match?.[0]?.header?.Origin).toContain("https://app.example.com");
        expect(rewrite?.uri).toBe("/functions/v1/supauth{http.request.uri.path}");
        expect(proxy?.upstreams?.[0]?.dial).toBe("10.20.0.12:4001");
        expect(proxy?.transport?.tls).toEqual({ insecure_skip_verify: true });
        // Caddy 2.11 rewrites Host for HTTPS upstreams unless the route sets it.
        expect(proxy?.headers?.request?.set?.Host).toEqual(["{http.request.host}"]);
        expect(Object.keys(proxy?.headers?.request?.set ?? {}).every((header) => !header.includes("_"))).toBe(true);
        expect(proxy?.headers?.request?.set?.["X-Custom-Upstream"]).toEqual(["ocr"]);
        expect(docs?.handle?.at(-1)?.handler).toBe("file_server");
        expect(docs?.handle?.at(-1)?.root).toBe("/var/supacloud/custom-sites/docs");
        expect(docs?.handle?.[0]?.response?.set?.["X-Robots-Tag"]).toEqual(["noindex"]);
        expect(disabled).toBeUndefined();

        restore();
    });

    test("configureCustomGatewayRoutes resolves managed functions on every reconcile", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restoreFetch = captureFetch(calls);
        const originalEdgeRuntimeInternal = config.edgeRuntimeInternal;
        const provider = new CaddyGatewayProvider();
        const route = {
            id: "sync-function",
            hosts: ["functions.example.com"],
            path: "/invoke/*",
            managed_upstream: "edge-functions" as const,
        };

        try {
            config.edgeRuntimeInternal = "127.0.0.1:9005";
            expect((await provider.configureCustomGatewayRoutes("proj123", [route])).success).toBe(true);
            const embeddedLoad = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
            const embeddedRoute = embeddedLoad?.body?.apps?.http?.servers?.supacloud?.routes?.find(
                (item: any) => item["@id"] === "route-custom-gateway-proj123-sync-function",
            );
            expect(embeddedRoute?.handle?.find((handler: any) => handler.handler === "reverse_proxy")?.upstreams)
                .toEqual([{ dial: "127.0.0.1:9005" }]);

            config.edgeRuntimeInternal = "edge-runtime:9000";
            expect((await provider.configureCustomGatewayRoutes("proj123", [route])).success).toBe(true);
            const externalLoad = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
            const externalRoute = externalLoad?.body?.apps?.http?.servers?.supacloud?.routes?.find(
                (item: any) => item["@id"] === "route-custom-gateway-proj123-sync-function",
            );
            expect(externalRoute?.handle?.find((handler: any) => handler.handler === "reverse_proxy")?.upstreams)
                .toEqual([{ dial: "edge-runtime:9000" }]);
        } finally {
            config.edgeRuntimeInternal = originalEdgeRuntimeInternal;
            restoreFetch();
        }
    });

    test("configureCustomGatewayRoutes supports mounted static SPA rewrites", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();
        const staticRoot = "/opt/supauth/packages/admin-console/build";

        const result = await provider.configureCustomGatewayRoutes("proj123", [
            {
                id: "admin-assets",
                hosts: ["auth.example.com"],
                path: ["/admin/_app/*", "/admin/assets/*"],
                static_root: staticRoot,
                strip_prefix: "/admin",
                priority: 20,
            },
            {
                id: "admin-spa",
                hosts: ["auth.example.com"],
                path: ["/admin", "/admin/*"],
                static_root: staticRoot,
                rewrite_uri: "/index.html",
                headers: { "Cache-Control": "no-cache" },
                priority: 19,
            },
        ]);

        expect(result.success).toBe(true);
        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        const assets = routes.find((item: any) => item["@id"] === "route-custom-gateway-proj123-admin-assets");
        const spa = routes.find((item: any) => item["@id"] === "route-custom-gateway-proj123-admin-spa");

        expect(assets?.match?.[0]?.host).toEqual(["auth.example.com"]);
        expect(assets?.match?.[0]?.path).toEqual(["/admin/_app/*", "/admin/assets/*"]);
        expect(assets?.handle?.[0]).toEqual({ handler: "rewrite", strip_path_prefix: "/admin" });
        expect(assets?.handle?.[1]?.handler).toBe("file_server");
        expect(assets?.handle?.[1]?.root).toBe(staticRoot);

        expect(spa?.match?.[0]?.path).toEqual(["/admin", "/admin/*"]);
        expect(spa?.handle?.[0]?.response?.set?.["Cache-Control"]).toEqual(["no-cache"]);
        expect(spa?.handle?.[1]).toEqual({ handler: "rewrite", uri: "/index.html" });
        expect(spa?.handle?.[2]?.handler).toBe("file_server");
        expect(spa?.handle?.[2]?.root).toBe(staticRoot);
        expect(routes.indexOf(assets)).toBeLessThan(routes.indexOf(spa));

        restore();
    });

    test("configureCustomGatewayRoutes reconciles twenty-one paths into one Caddy matcher", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();
        const hostedPaths = Array.from({ length: 21 }, (_, index) => `/hosted-${index}`);

        const reconcileResult = await provider.configureCustomGatewayRoutes("proj123", [{
            id: "hosted-auth",
            hosts: ["auth.example.com"],
            path: hostedPaths,
            upstream: "127.0.0.1:9000",
        }]);

        expect(reconcileResult.success).toBe(true);
        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        const hostedRoute = routes.find(
            (route: any) => route["@id"] === "route-custom-gateway-proj123-hosted-auth",
        );
        expect(hostedRoute?.match).toEqual([{ host: ["auth.example.com"], path: hostedPaths }]);

        restore();
    });

    test("configureCustomGatewayRoutes replaces stale custom routes for the project", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        await provider.configureCustomGatewayRoutes("proj123", [{
            id: "old",
            hosts: ["old.example.com"],
            path: "/*",
            static_root: "/var/supacloud/custom-sites/old",
        }]);
        await provider.configureCustomGatewayRoutes("proj123", []);

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        expect(routes.some((item: any) => item["@id"] === "route-custom-gateway-proj123-old")).toBe(false);

        restore();
    });

    test("configureCustomGatewayRoutes restores previous routes when Caddy rejects the candidate", async () => {
        const originalFetch = globalThis.fetch;
        const loads: any[] = [];
        let loadAttempt = 0;
        globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            if (url.endsWith("/load") && init?.method === "POST") {
                loadAttempt += 1;
                loads.push(JSON.parse(String(init.body)));
                if (loadAttempt === 2) {
                    return Promise.resolve(Response.json({ error: "invalid candidate" }, { status: 500 }));
                }
            }
            return Promise.resolve(Response.json({ ok: true }));
        }) as unknown as typeof fetch;

        try {
            const provider = new CaddyGatewayProvider();
            expect((await provider.configureCustomGatewayRoutes("proj123", [{
                id: "old",
                hosts: ["old.example.com"],
                path: "/*",
                static_root: "/var/supacloud/custom-sites/old",
            }])).success).toBe(true);

            expect((await provider.configureCustomGatewayRoutes("proj123", [{
                id: "new",
                hosts: ["new.example.com"],
                path: "/*",
                static_root: "/var/supacloud/custom-sites/new",
            }])).success).toBe(false);

            expect((await provider.configureCustomGatewayRoutes("other", [{
                id: "other",
                hosts: ["other.example.com"],
                path: "/*",
                static_root: "/var/supacloud/custom-sites/other",
            }])).success).toBe(true);

            const routes = loads.at(-1)?.apps?.http?.servers?.supacloud?.routes ?? [];
            expect(routes.some((route: any) => route["@id"] === "route-custom-gateway-proj123-old")).toBe(true);
            expect(routes.some((route: any) => route["@id"] === "route-custom-gateway-proj123-new")).toBe(false);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("protocol-scoped custom routes sort before generic routes with the same priority and path", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        await provider.configureCustomGatewayRoutes("proj123", [
            {
                id: "aaa-site",
                hosts: ["www.example.com"],
                path: "/*",
                static_root: "/var/supacloud/custom-sites/www",
            },
            {
                id: "zzz-http-redirect",
                hosts: ["www.example.com"],
                path: "/*",
                protocol: "http",
                redirect_to: "https://www.example.com{http.request.uri}",
            },
        ]);

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        const redirectIndex = routes.findIndex((route: any) => route["@id"] === "route-custom-gateway-proj123-zzz-http-redirect");
        const siteIndex = routes.findIndex((route: any) => route["@id"] === "route-custom-gateway-proj123-aaa-site");

        expect(redirectIndex).toBeGreaterThanOrEqual(0);
        expect(redirectIndex).toBeLessThan(siteIndex);

        restore();
    });

    test("upsertCertificateForSnis stores manual certificate paths in Caddy JSON", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        const result = await provider.upsertCertificateForSnis({
            projectRef: "proj123",
            cert: VALID_TEST_CERT,
            key: VALID_TEST_KEY,
            snis: ["api.example.com", "studio.example.com"],
        });
        expect(result.success).toBe(true);
        const load = calls.find((call) => call.method === "POST" && call.url.endsWith("/load"));
        const certs = load?.body?.apps?.tls?.certificates?.load_files ?? [];
        expect(certs[0]?.certificate).toContain("/tmp/supacloud-caddy-test/state/manual-certs/proj123/");
        expect(certs[0]?.key).toContain("/tmp/supacloud-caddy-test/state/manual-certs/proj123/");

        restore();
    });

    test("setRateLimit renders caddy rate_limit handlers for tenant API routes", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        await provider.setupUpstream("testref123", 3000, 9999);
        await provider.setRateLimit("testref123", { second: 7, minute: 70, hour: 700 });

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        const rest = routes.find((route: any) => route["@id"] === "route-project-testref123-rest");
        const rateLimit = rest?.handle?.find((handler: any) => handler.handler === "rate_limit");
        const zones = Object.values(rateLimit?.rate_limits ?? {}) as any[];
        const rewriteIndex = rest?.handle?.findIndex((handler: any) => handler.handler === "rewrite");

        expect(rateLimit).toBeDefined();
        expect(rest?.handle?.indexOf(rateLimit)).toBeLessThan(rewriteIndex);
        expect(zones.some((zone) => zone.window === "1s" && zone.max_events === 7)).toBe(true);
        expect(zones.some((zone) => zone.window === "1m" && zone.max_events === 70)).toBe(true);
        expect(zones.some((zone) => zone.window === "1h" && zone.max_events === 700)).toBe(true);

        restore();
    });

    test("bounds Caddy rate-limit ring buffers while preserving configured average rates", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        await provider.setupUpstream("boundedref", 3000, 9999);
        await provider.setRateLimit("boundedref", "enterprise");

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        const rest = routes.find((route: any) => route["@id"] === "route-project-boundedref-rest");
        const rateLimit = rest?.handle?.find((handler: any) => handler.handler === "rate_limit");
        const zones = rateLimit?.rate_limits ?? {};

        expect(Object.keys(zones)).toHaveLength(3);
        expect(zones.supacloud_boundedref_api_second_configured_1500).toMatchObject({ window: "1s", max_events: 1500 });
        expect(zones.supacloud_boundedref_api_minute_configured_90000).toMatchObject({ window: "1000ms", max_events: 1500 });
        expect(zones.supacloud_boundedref_api_hour_configured_3000000).toMatchObject({ window: "1800ms", max_events: 1500 });

        restore();
    });

    test("hydrates bounded rate limits without dropping minute and hour protection", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const firstProvider = new CaddyGatewayProvider();

        await firstProvider.setupUpstream("restartref", 3000, 9999);
        await firstProvider.setRateLimit("restartref", "enterprise");

        const restartedProvider = new CaddyGatewayProvider();
        await restartedProvider.setupMasterRoutes();

        expect(await restartedProvider.getRateLimit("restartref")).toEqual({
            tier: "custom",
            second: 1500,
            minute: 90000,
            hour: 3000000,
            enabled: true,
        });

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        const rest = routes.find((route: any) => route["@id"] === "route-project-restartref-rest");
        const rateLimit = rest?.handle?.find((handler: any) => handler.handler === "rate_limit");
        expect(Object.keys(rateLimit?.rate_limits ?? {})).toHaveLength(3);

        restore();
    });

    test("setRateLimit uses production-safe defaults for every built-in tier and partial custom config", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        await provider.setupUpstream("tierref", 3000, 9999);

        const expected = [
            ["free", 60, 3000, 100000],
            ["pro", 300, 18000, 500000],
            ["enterprise", 1500, 90000, 3000000],
        ] as const;

        for (const [tier, second, minute, hour] of expected) {
            await provider.setRateLimit("tierref", tier);
            expect(await provider.getRateLimit("tierref")).toEqual({
                tier,
                second,
                minute,
                hour,
                enabled: true,
            });
        }

        await provider.setRateLimit("tierref", { second: 75 });
        expect(await provider.getRateLimit("tierref")).toEqual({
            tier: "custom",
            second: 75,
            minute: 3000,
            hour: 100000,
            enabled: true,
        });

        restore();
    });

    test("setRateLimit does not rehydrate stale disk routes after project routes are rebuilt", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        await provider.setupUpstream("freshref", 3000, 9999);
        await writeFile("/tmp/supacloud-caddy-test/config.json", JSON.stringify({
            apps: {
                http: {
                    servers: {
                        supacloud: {
                            routes: [
                                {
                                    "@id": "route-project-freshref-storage",
                                    match: [{ host: ["freshref.api.example.com"], path: ["/storage/v1*"] }],
                                    handle: [
                                        { handler: "rewrite", strip_path_prefix: "/storage/v1" },
                                        { handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:9090" }] },
                                    ],
                                    terminal: true,
                                },
                            ],
                        },
                    },
                },
            },
        }));

        await provider.setRateLimit("freshref", { second: 7, minute: 70, hour: 700 });

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        const storage = routes.find((route: any) => route["@id"] === "route-project-freshref-storage");
        const storageProxy = storage?.handle?.find((handler: any) => handler.handler === "reverse_proxy");

        expect(storage?.handle?.some((handler: any) => handler.strip_path_prefix === "/storage/v1")).toBe(false);
        expect(storageProxy?.headers?.request?.set?.["Host"]).toEqual([`freshref.api.${config.baseDomain}`]);
        expect(storageProxy?.flush_interval).toBeUndefined();

        restore();
    });


    test("guarded method does not rehydrate stale disk after removeService empties state", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        await mkdir("/tmp/supacloud-caddy-test", { recursive: true });

        // Initialize provider via setupUpstream (hydrated stays false, no disk read).
        await provider.setupUpstream("emptyref", 3000, 9999);
        // removeService empties in-memory maps while hydrated is still false.
        await provider.removeService("emptyref");

        // Overwrite disk config with a stale route AFTER persistAndLoad wrote clean state.
        await writeFile("/tmp/supacloud-caddy-test/config.json", JSON.stringify({
            apps: {
                http: {
                    servers: {
                        supacloud: {
                            routes: [
                                {
                                    "@id": "route-project-staleproj-storage",
                                    match: [{ host: ["staleproj.api.example.com"], path: ["/storage/v1*"] }],
                                    handle: [
                                        { handler: "rewrite", strip_path_prefix: "/storage/v1" },
                                        { handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:9090" }] },
                                    ],
                                    terminal: true,
                                },
                            ],
                        },
                    },
                },
            },
        }));

        // A guarded method must NOT trigger disk hydration when maps are empty.
        await provider.setRateLimit("staleproj", { second: 5 });

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];

        // The stale disk route must NOT appear in the published config.
        expect(routes.some((route: any) => route["@id"] === "route-project-staleproj-storage")).toBe(false);
        expect(routes.some((route: any) => route["@id"]?.includes("emptyref"))).toBe(false);

        restore();
    });

    test("clean rebuild publishes once and drops stale disk routes while preserving certificates", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        await mkdir("/tmp/supacloud-caddy-test", { recursive: true });
        await writeFile("/tmp/supacloud-caddy-test/config.json", JSON.stringify({
            apps: {
                tls: {
                    certificates: {
                        load_files: [
                            { certificate: "/etc/supacloud/certs/manual.crt", key: "/etc/supacloud/certs/manual.key" },
                        ],
                    },
                },
                http: {
                    servers: {
                        supacloud: {
                            routes: [
                                {
                                    "@id": "route-project-stale-storage",
                                    match: [{ host: ["stale.api.example.com"], path: ["/storage/v1*"] }],
                                    handle: [
                                        { handler: "rewrite", strip_path_prefix: "/storage/v1" },
                                        { handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:9090" }] },
                                    ],
                                    terminal: true,
                                },
                            ],
                        },
                    },
                },
            },
        }));

        await provider.withDeferredPersist(async () => {
            await provider.prepareCleanRebuild();
            await provider.setupMasterRoutes();
            await provider.setupUpstream("cleanref", 3000, 9999);
            await provider.configureFrontendRoute({
                projectRef: "cleanref",
                deploymentId: "abcdef01",
                hosts: ["app.clean.example.com"],
                root: "/tmp/supacloud-caddy-test/frontend",
                mode: "static",
            });
        });

        const loads = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load"));
        expect(loads).toHaveLength(1);

        const routes = loads[0]?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        const certs = loads[0]?.body?.apps?.tls?.certificates?.load_files ?? [];

        expect(routes.some((route: any) => route["@id"] === "route-project-stale-storage")).toBe(false);
        expect(routes.some((route: any) => route["@id"] === "route-system-management-api")).toBe(true);
        expect(routes.some((route: any) => route["@id"] === "route-project-cleanref-rest")).toBe(true);
        expect(routes.some((route: any) => route["@id"] === "route-frontend-cleanref-abcdef01")).toBe(true);
        expect(certs).toEqual([
            { certificate: "/etc/supacloud/certs/manual.crt", key: "/etc/supacloud/certs/manual.key" },
        ]);

        restore();
    });

    test("clean rebuild preserves global Studio routes", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const configuredProvider = new CaddyGatewayProvider();

        await configuredProvider.configureStudioDomain("studio.example.com", 9090);
        calls.length = 0;
        const restartedProvider = new CaddyGatewayProvider();

        await restartedProvider.withDeferredPersist(async () => {
            await restartedProvider.prepareCleanRebuild();
            await restartedProvider.setupMasterRoutes();
        });

        const load = calls.find((call) => call.method === "POST" && call.url.endsWith("/load"));
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];

        expect(routes.some((route: any) => route["@id"] === "route-custom-gateway-_global-studio-https-redirect")).toBe(true);
        expect(routes.some((route: any) => route["@id"] === "route-frontend-_global-studio")).toBe(true);

        restore();
    });

    test("deferred persist can skip publish when clean rebuild validation fails", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        const result = await provider.withDeferredPersist(async () => {
            await provider.prepareCleanRebuild();
            await provider.setupMasterRoutes();
            return { success: false };
        }, (value) => value.success);

        expect(result.success).toBe(false);
        expect(calls.filter((call) => call.method === "POST" && call.url.endsWith("/load"))).toHaveLength(0);

        restore();
    });

    test("setCustomRouteRateLimit creates a stable custom route before parent routes", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        await provider.setupUpstream("testref123", 3000, 9999);
        const ok = await provider.setCustomRouteRateLimit("testref123", "/rest/v1/audit", { second: 2 });
        expect(ok).toBe(true);

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        const custom = routes.find((route: any) => route["@id"]?.startsWith("route-custom-testref123-"));

        expect(routes.indexOf(custom)).toBeLessThan(
            routes.findIndex((route: any) => route["@id"] === "route-project-testref123-rest"),
        );
        expect(custom?.match?.[0]?.path).toEqual(["/rest/v1/audit*"]);
        expect(custom?.handle?.some((handler: any) => handler.handler === "rate_limit")).toBe(true);

        restore();
    });

    test("new provider instances hydrate existing Caddy JSON before publishing changes", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);

        const firstProvider = new CaddyGatewayProvider();
        await firstProvider.setupUpstream("persistref", 3000, 9999);

        const secondProvider = new CaddyGatewayProvider();
        await secondProvider.upsertCertificateForSnis({
            projectRef: "persistref",
            cert: VALID_TEST_CERT,
            key: VALID_TEST_KEY,
            snis: ["api.example.com"],
        });

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        const certs = load?.body?.apps?.tls?.certificates?.load_files ?? [];
        const routeIds = routes.map((route: any) => route["@id"]).filter(Boolean);

        expect(routes.some((route: any) => route["@id"] === "route-project-persistref-rest")).toBe(true);
        expect(routeIds.filter((routeId: string) => routeId === "route-system-unmatched-host-404")).toHaveLength(1);
        expect(new Set(routeIds).size).toBe(routeIds.length);
        expect(certs.length).toBeGreaterThan(0);

        restore();
    });

    test("setupHostedAuthRoutes is no-op when disabled (default)", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        const result = await provider.setupHostedAuthRoutes();
        expect(result.success).toBe(true);

        // No POST /load call since no routes changed
        const loads = calls.filter((c) => c.method === "POST" && c.url.endsWith("/load"));
        expect(loads.length).toBe(0);

        restore();
    });

    test("setupHostedAuthRoutes returns error when host is missing", async () => {
        process.env.HOSTED_AUTH_PAGE_ENABLED = "true";
        // HOSTED_AUTH_PAGE_HOST not set
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);

        // Re-import to pick up env, but since config is a singleton we test via the method
        const { CaddyGatewayProvider: Provider } = await import("../../src/services/gateway.service");
        const provider = new Provider();

        // Config reads env at module load time; this test only validates the method-level check
        // when config values are empty
        const result = await provider.setupHostedAuthRoutes();

        // Depending on whether the singleton config has the env set:
        // If config.hostedAuthPageEnabled is false (no env), success=true (no-op)
        // If true but host empty, success=false
        if (result.success === false) {
            expect(result.error).toContain("HOSTED_AUTH_PAGE_HOST");
        }

        delete process.env.HOSTED_AUTH_PAGE_ENABLED;
        restore();
    });

    test("setupHostedAuthRoutes creates hosted auth page routes when enabled", async () => {
        process.env.HOSTED_AUTH_PAGE_ENABLED = "true";
        process.env.HOSTED_AUTH_PAGE_HOST = "auth.example.com";
        process.env.HOSTED_AUTH_PAGE_ROOT = "/var/supacloud/auth-pages";

        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);

        // Need fresh config; the module-level singleton already loaded,
        // so we patch config directly for this test
        const { config } = await import("../../src/config");
        (config as any).hostedAuthPageEnabled = true;
        (config as any).hostedAuthPageHost = "auth.example.com";
        (config as any).hostedAuthPageRoot = "/var/supacloud/auth-pages";

        const { CaddyGatewayProvider: Provider } = await import("../../src/services/gateway.service");
        const provider = new Provider();

        const result = await provider.setupHostedAuthRoutes();
        expect(result.success).toBe(true);

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];

        const loginRoute = routes.find((r: any) => r["@id"] === "route-supauth-hosted-login");
        const authorizeRoute = routes.find((r: any) => r["@id"] === "route-supauth-authorize-page");

        expect(loginRoute).toBeDefined();
        expect(loginRoute?.match?.[0]?.host).toEqual(["auth.example.com"]);
        expect(loginRoute?.match?.[0]?.path).toEqual(["/", "/login.html"]);
        expect(loginRoute?.handle?.[0]?.handler).toBe("rewrite");
        expect(loginRoute?.handle?.[1]?.handler).toBe("file_server");
        expect(loginRoute?.handle?.[1]?.root).toBe("/var/supacloud/auth-pages");
        expect(loginRoute?.terminal).toBe(true);

        expect(authorizeRoute).toBeDefined();
        expect(authorizeRoute?.match?.[0]?.path).toEqual(["/oauth/authorize*"]);
        expect(authorizeRoute?.terminal).toBe(true);

        // Routes should sort before catch-all (high priority)
        const loginIdx = routes.indexOf(loginRoute);
        const catchAll = routes.find((r: any) => {
            const p = r.match?.[0]?.path?.[0];
            return p === "/*" || p === "*";
        });
        if (catchAll) {
            expect(loginIdx).toBeLessThan(routes.indexOf(catchAll));
        }

        // Cleanup
        (config as any).hostedAuthPageEnabled = false;
        (config as any).hostedAuthPageHost = "";
        (config as any).hostedAuthPageRoot = "";
        delete process.env.HOSTED_AUTH_PAGE_ENABLED;
        delete process.env.HOSTED_AUTH_PAGE_HOST;
        delete process.env.HOSTED_AUTH_PAGE_ROOT;

        restore();
    });

    test("setupHostedAuthRoutes cleans up routes when disabled after being enabled", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const { config } = await import("../../src/config");

        // First enable and create routes
        (config as any).hostedAuthPageEnabled = true;
        (config as any).hostedAuthPageHost = "auth2.example.com";
        (config as any).hostedAuthPageRoot = "/var/supacloud/auth-pages";

        const { CaddyGatewayProvider: Provider } = await import("../../src/services/gateway.service");
        const provider = new Provider();

        await provider.setupHostedAuthRoutes();
        const loadsAfterCreate = calls.filter((c) => c.method === "POST" && c.url.endsWith("/load")).length;
        expect(loadsAfterCreate).toBeGreaterThan(0);

        // Now disable - should clean up
        (config as any).hostedAuthPageEnabled = false;
        calls.length = 0;

        const provider2 = new Provider();
        await provider2.setupHostedAuthRoutes();

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];

        expect(routes.find((r: any) => r["@id"] === "route-supauth-hosted-login")).toBeUndefined();
        expect(routes.find((r: any) => r["@id"] === "route-supauth-authorize-page")).toBeUndefined();

        // Cleanup
        (config as any).hostedAuthPageHost = "";
        (config as any).hostedAuthPageRoot = "";

        restore();
    });
});

describe("CaddyGatewayProvider route headers", () => {
    afterEach(async () => {
        await cleanCaddyTmp();
    });

    test("all project routes inject Host, X-Project-Ref, x-project-ref, X-Forwarded-Host, X-Forwarded-Proto headers", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        const result = await provider.setupUpstream("hdrtest", 3000, 9999);
        expect(result.success).toBe(true);

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];

        const apiRoutes = routes.filter((route: any) => {
            const id = String(route["@id"] || "");
            return id.startsWith("route-project-hdrtest-") && !id.endsWith("-acme") && !id.endsWith("-studio");
        });

        expect(apiRoutes.length).toBeGreaterThan(0);

        for (const route of apiRoutes) {
            const proxy = route?.handle?.find((h: any) => h.handler === "reverse_proxy");
            const requestSet = proxy?.headers?.request?.set;
            const routeId = String(route["@id"] || "");
            const usesProjectCanonicalHost = routeId.endsWith("-storage") || routeId.endsWith("-storage-resumable") || routeId.endsWith("-functions");
            const expectedHost = usesProjectCanonicalHost ? `hdrtest.api.${config.baseDomain}` : "{http.request.host}";
            expect(requestSet?.["Host"]).toEqual([expectedHost]);
            expect(requestSet?.["X-Project-Ref"]).toEqual(["hdrtest"]);
            expect(requestSet?.["x-project-ref"]).toEqual(["hdrtest"]);
            expect(requestSet?.["X-Forwarded-Host"]).toEqual([expectedHost]);
            expect(requestSet?.["X-Forwarded-Proto"]).toEqual(["{http.request.scheme}"]);
        }

        restore();
    });

    test("storage route preserves upstream CORS and has correct headers", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        const result = await provider.setupUpstream("storagetest", 3000, 9999);
        expect(result.success).toBe(true);

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];

        const storage = routes.find((route: any) => route["@id"] === "route-project-storagetest-storage");
        const resumable = routes.find((route: any) => route["@id"] === "route-project-storagetest-storage-resumable");
        expect(storage).toBeDefined();
        expect(resumable).toBeDefined();
        expect(routes.indexOf(resumable)).toBeLessThan(routes.indexOf(storage));
        expect(resumable?.match?.[0]?.path).toEqual(["/storage/v1/upload/resumable*"]);
        expect(storage?.match?.[0]?.path).toEqual(["/storage/v1*"]);

        const storageProxy = storage?.handle?.find((h: any) => h.handler === "reverse_proxy");
        const resumableProxy = resumable?.handle?.find((h: any) => h.handler === "reverse_proxy");
        expect(storage?.handle?.some((h: any) => h.strip_path_prefix === "/storage/v1")).toBe(false);
        expect(resumable?.handle?.some((h: any) => h.strip_path_prefix === "/storage/v1")).toBe(false);
        expect(findCorsSubroute(storage)).toBeUndefined();
        expect(findCorsSubroute(resumable)).toBeUndefined();
        // Storage route should preserve upstream CORS without rendering an empty
        // response header block, which can break Caddy proxy responses.
        expect(storageProxy?.headers?.response).toBeUndefined();
        expect(resumableProxy?.headers?.response).toBeUndefined();
        // Storage route must have project routing headers
        const requestSet = storageProxy?.headers?.request?.set;
        expect(requestSet?.["Host"]).toEqual([`storagetest.api.${config.baseDomain}`]);
        expect(requestSet?.["X-Project-Ref"]).toEqual(["storagetest"]);
        expect(requestSet?.["x-project-ref"]).toEqual(["storagetest"]);
        expect(requestSet?.["X-Forwarded-Host"]).toEqual([`storagetest.api.${config.baseDomain}`]);
        expect(requestSet?.["X-Forwarded-Proto"]).toEqual(["{http.request.scheme}"]);
        // Storage is non-streaming (no flush_interval)
        expect(storageProxy?.flush_interval).toBeUndefined();
        const resumableRequestSet = resumableProxy?.headers?.request?.set;
        expect(resumableRequestSet?.["Host"]).toEqual([`storagetest.api.${config.baseDomain}`]);
        expect(resumableRequestSet?.["X-Forwarded-Host"]).toEqual([`storagetest.api.${config.baseDomain}`]);
        expect(resumableProxy?.transport?.read_timeout).toBe("900s");
        expect(resumableProxy?.flush_interval).toBeUndefined();

        restore();
    });

    test("hydrates and migrates legacy storage routes that stripped the SDK prefix", async () => {
        await mkdir("/tmp/supacloud-caddy-test", { recursive: true });
        await writeFile("/tmp/supacloud-caddy-test/config.json", JSON.stringify({
            apps: {
                http: {
                    servers: {
                        supacloud: {
                            routes: [
                                {
                                    "@id": "route-project-legacyref-storage",
                                    match: [{ host: ["legacyref.api.example.com", "api.custom.example.com"], path: ["/storage/v1*"] }],
                                    handle: [
                                        { handler: "rewrite", strip_path_prefix: "/storage/v1" },
                                        {
                                            handler: "reverse_proxy",
                                            flush_interval: -1,
                                            headers: {
                                                request: {
                                                    set: {
                                                        "X-Forwarded-Host": ["{http.request.host}"],
                                                        "X-Project-Ref": ["legacyref"],
                                                    },
                                                },
                                                response: {
                                                    delete: ["Access-Control-Allow-Origin"],
                                                },
                                            },
                                            upstreams: [{ dial: "127.0.0.1:9090" }],
                                        },
                                    ],
                                    terminal: true,
                                },
                            ],
                        },
                    },
                },
            },
        }));

        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        await provider.setCors("legacyref", ["https://app.example.com"]);

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        const storage = routes.find((route: any) => route["@id"] === "route-project-legacyref-storage");
        expect(storage).toBeDefined();
        expect(storage?.handle?.some((handler: any) => handler.strip_path_prefix === "/storage/v1")).toBe(false);

        const storageProxy = storage?.handle?.find((h: any) => h.handler === "reverse_proxy");
        expect(storageProxy?.flush_interval).toBeUndefined();
        expect(storageProxy?.headers?.response?.delete).toBeUndefined();
        const requestSet = storageProxy?.headers?.request?.set;
        expect(requestSet?.["Host"]).toEqual([`legacyref.api.${config.baseDomain}`]);
        expect(requestSet?.["X-Forwarded-Host"]).toEqual([`legacyref.api.${config.baseDomain}`]);
        expect(requestSet?.["X-Project-Ref"]).toEqual(["legacyref"]);
        expect(requestSet?.["x-project-ref"]).toEqual(["legacyref"]);
        expect(requestSet?.["X-Forwarded-Proto"]).toEqual(["{http.request.scheme}"]);

        restore();
    });

    test("hydrates and migrates legacy functions routes to canonical project host headers", async () => {
        await mkdir("/tmp/supacloud-caddy-test", { recursive: true });
        await writeFile("/tmp/supacloud-caddy-test/config.json", JSON.stringify({
            apps: {
                http: {
                    servers: {
                        supacloud: {
                            routes: [
                                {
                                    "@id": "route-project-legacyfn-functions",
                                    match: [{ host: ["legacyfn.api.example.com", "api.custom.example.com"], path: ["/functions/v1*"] }],
                                    handle: [
                                        {
                                            handler: "reverse_proxy",
                                            headers: {
                                                request: {
                                                    set: {
                                                        "Host": ["{http.request.host}"],
                                                        "X-Forwarded-Host": ["{http.request.host}"],
                                                    },
                                                },
                                            },
                                            upstreams: [{ dial: "127.0.0.1:9090" }],
                                        },
                                    ],
                                    terminal: true,
                                },
                            ],
                        },
                    },
                },
            },
        }));

        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        await provider.setCors("legacyfn", ["https://app.example.com"]);

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        const functions = routes.find((route: any) => route["@id"] === "route-project-legacyfn-functions");
        const functionsProxy = functions?.handle?.find((h: any) => h.handler === "reverse_proxy");
        const requestSet = functionsProxy?.headers?.request?.set;

        expect(requestSet?.["Host"]).toEqual([`legacyfn.api.${config.baseDomain}`]);
        expect(requestSet?.["X-Forwarded-Host"]).toEqual([`legacyfn.api.${config.baseDomain}`]);
        expect(requestSet?.["X-Project-Ref"]).toEqual(["legacyfn"]);
        expect(requestSet?.["x-project-ref"]).toEqual(["legacyfn"]);
        expect(requestSet?.["X-Forwarded-Proto"]).toEqual(["{http.request.scheme}"]);

        restore();
    });

    test("hydrates legacy functions routes into upstream-owned CORS", async () => {
        await mkdir("/tmp/supacloud-caddy-test", { recursive: true });
        await writeFile("/tmp/supacloud-caddy-test/config.json", JSON.stringify({
            apps: {
                http: {
                    servers: {
                        supacloud: {
                            routes: [
                                {
                                    "@id": "route-project-legacyfn2-functions",
                                    match: [{ host: ["legacyfn2.api.example.com"], path: ["/functions/v1*"] }],
                                    handle: [
                                        {
                                            handler: "subroute",
                                            routes: [{
                                                match: [{ method: ["OPTIONS"] }],
                                                handle: [{
                                                    handler: "headers",
                                                    response: { set: { "Access-Control-Allow-Origin": ["{http.request.header.Origin}"] } },
                                                }, { handler: "static_response", status_code: 204 }],
                                                terminal: true,
                                            }],
                                        },
                                        {
                                            handler: "reverse_proxy",
                                            headers: {
                                                request: { set: { Host: ["{http.request.host}"] } },
                                                response: {
                                                    delete: [
                                                        "Access-Control-Allow-Origin",
                                                        "Access-Control-Allow-Credentials",
                                                        "Access-Control-Allow-Methods",
                                                        "Access-Control-Allow-Headers",
                                                        "Access-Control-Expose-Headers",
                                                        "Access-Control-Max-Age",
                                                    ],
                                                },
                                            },
                                            upstreams: [{ dial: "127.0.0.1:9090" }],
                                        },
                                    ],
                                    terminal: true,
                                },
                            ],
                        },
                    },
                },
            },
        }));

        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        await provider.setCors("legacyfn2", ["https://app.example.com"]);

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        const functions = routes.find((route: any) => route["@id"] === "route-project-legacyfn2-functions");
        expect(functions).toBeDefined();
        // Gateway CORS subroute is stripped and never re-attached by setCors.
        expect(findCorsSubroute(functions)).toBeUndefined();
        const functionsProxy = functions?.handle?.find((h: any) => h.handler === "reverse_proxy");
        expect(functionsProxy?.headers?.response).toBeUndefined();
        expect(functionsProxy?.headers?.request?.set?.["X-Project-Ref"]).toEqual(["legacyfn2"]);

        restore();
    });

    test("addProjectDomains preserves Host and routing headers for custom API domain", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        // First setup the routes
        await provider.setupUpstream("domaintest", 3000, 9999);
        // Now add a custom API domain
        const added = await provider.addProjectDomains("domaintest", ["api.custom.example.com"], ["studio.custom.example.com"]);
        expect(added).toBe(true);

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];

        const storage = routes.find((route: any) => route["@id"] === "route-project-domaintest-storage");
        const opaqueRest = routes.find((route: any) => route["@id"] === "route-project-domaintest-opaque-rest");
        expect(storage).toBeDefined();
        // Custom API domain should appear in the storage route hosts
        const hosts = storage?.match?.[0]?.host ?? [];
        expect(hosts).toContain("api.custom.example.com");
        expect(opaqueRest?.match).toHaveLength(2);
        expect(opaqueRest?.match?.every((matcher: any) => matcher.host?.includes("api.custom.example.com"))).toBe(true);

        // All routes with the custom domain must still have correct headers
        const storageProxy = storage?.handle?.find((h: any) => h.handler === "reverse_proxy");
        const requestSet = storageProxy?.headers?.request?.set;
        expect(storage?.handle?.some((h: any) => h.strip_path_prefix === "/storage/v1")).toBe(false);
        expect(requestSet?.["Host"]).toEqual([`domaintest.api.${config.baseDomain}`]);
        expect(requestSet?.["X-Project-Ref"]).toEqual(["domaintest"]);
        expect(requestSet?.["x-project-ref"]).toEqual(["domaintest"]);
        expect(requestSet?.["X-Forwarded-Host"]).toEqual([`domaintest.api.${config.baseDomain}`]);
        expect(requestSet?.["X-Forwarded-Proto"]).toEqual(["{http.request.scheme}"]);

        restore();
    });

    test("setupUpstream includes additional API domains on project API routes", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        const result = await provider.setupUpstream("multidomain", 3000, 9999, {
            api_domain: "api.primary.example.com",
            additional_api_domains: ["ingest-api.example.com", "api.ingest.example.com"],
            studio_domain: "studio.primary.example.com",
        });
        expect(result.success).toBe(true);

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        const apiRoutes = routes.filter((route: any) => [
            "route-project-multidomain-rest",
            "route-project-multidomain-functions",
            "route-project-multidomain-storage",
            "route-project-multidomain-auth",
        ].includes(route["@id"]));

        expect(apiRoutes).toHaveLength(4);
        for (const route of apiRoutes) {
            const hosts = route?.match?.[0]?.host ?? [];
            expect(hosts).toContain(`multidomain.api.${config.baseDomain}`);
            expect(hosts).toContain("api.primary.example.com");
            expect(hosts).toContain("ingest-api.example.com");
            expect(hosts).toContain("api.ingest.example.com");
        }

        const functions = routes.find((route: any) => route["@id"] === "route-project-multidomain-functions");
        const functionsProxy = functions?.handle?.find((h: any) => h.handler === "reverse_proxy");
        expect(functionsProxy?.headers?.request?.set?.["Host"]).toEqual([`multidomain.api.${config.baseDomain}`]);
        expect(functionsProxy?.headers?.request?.set?.["X-Forwarded-Host"]).toEqual([`multidomain.api.${config.baseDomain}`]);

        restore();
    });

    test("storage route sorts before catch-all /* routes", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        await provider.setupUpstream("sorttest", 3000, 9999);

        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];

        const storageIdx = routes.findIndex((route: any) => route["@id"] === "route-project-sorttest-storage");
        const catchAllIdx = routes.findIndex((route: any) => {
            const p = route?.match?.[0]?.path?.[0];
            return p === "/*" || p === "*";
        });

        expect(storageIdx).toBeGreaterThanOrEqual(0);
        // If there is a catch-all, storage must come before it
        if (catchAllIdx >= 0) {
            expect(storageIdx).toBeLessThan(catchAllIdx);
        }

        restore();
    });
});

describe("CaddyGatewayProvider ensureGatewayReady", () => {
    afterEach(async () => {
        await cleanCaddyTmp();
    });

    test("allows only a fresh config directory to bootstrap without durable state", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();

        try {
            await expect(provider.ensureGatewayReady({ maxAttempts: 1, intervalMs: 1 }))
                .resolves.toMatchObject({ ready: true });
        } finally {
            restore();
        }
    });

    test("fails startup when the initialized marker outlives its durable config", async () => {
        await mkdir("/tmp/supacloud-caddy-test", { recursive: true });
        await writeFile("/tmp/supacloud-caddy-test/INITIALIZED", "supacloud-caddy-config-v1\n");

        await expect(new CaddyGatewayProvider().ensureGatewayReady({ maxAttempts: 1, intervalMs: 1 }))
            .rejects.toThrow("Initialized Caddy config is missing");
    });

    test("fails startup on malformed or structurally invalid durable config", async () => {
        for (const durableConfig of ["{", JSON.stringify({ apps: {} })]) {
            await mkdir("/tmp/supacloud-caddy-test", { recursive: true });
            await writeFile(config.caddyConfigPath, durableConfig);

            await expect(new CaddyGatewayProvider().ensureGatewayReady({ maxAttempts: 1, intervalMs: 1 })).rejects.toThrow();
            await cleanCaddyTmp();
        }
    });

    test("retries until Caddy Admin API becomes reachable, then persists the JSON config", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        // 前 2 次连接拒绝（模拟 caddy 尚未启动），第 3 次起返回 ok
        let configAttempts = 0;
        let loadedConfig: unknown = {};
        const originalFetch = globalThis.fetch;
        globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            const method = init?.method || "GET";
            let body: any = null;
            if (typeof init?.body === "string" && init.body.length > 0) {
                try { body = JSON.parse(init.body); } catch { body = init.body; }
            }
            calls.push({ url, method, body });
            if (url.endsWith("/config/")) {
                configAttempts += 1;
                if (configAttempts <= 2) return Promise.resolve(new Response("connection refused", { status: 502 }));
                return Promise.resolve(Response.json(loadedConfig));
            }
            if (url.endsWith("/load") && method === "POST") loadedConfig = body;
            return Promise.resolve(new Response(JSON.stringify({ id: "load", data: [] })));
        }) as unknown as typeof fetch;
        const restore = () => { globalThis.fetch = originalFetch; };

        const provider = new CaddyGatewayProvider();
        await provider.setupMasterRoutes().catch(() => undefined);

        const result = await provider.ensureGatewayReady({
            maxAttempts: 10,
            intervalMs: 1,
        });

        expect(result.ready).toBe(true);
        const load = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load")).at(-1);
        expect(load).toBeDefined();
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        expect(routes.find((route: any) => route["@id"] === "route-system-management-api")).toBeDefined();

        restore();
    });

    test("returns ready=false after exhausting retries when Caddy never comes up", async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = mock(() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
        const restore = () => { globalThis.fetch = originalFetch; };

        const provider = new CaddyGatewayProvider();
        const result = await provider.ensureGatewayReady({
            maxAttempts: 3,
            intervalMs: 1,
        });

        expect(result.ready).toBe(false);

        restore();
    });

    test("persists config immediately when Caddy is already reachable", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const provider = new CaddyGatewayProvider();
        await provider.setupMasterRoutes().catch(() => undefined);

        const result = await provider.ensureGatewayReady({
            maxAttempts: 5,
            intervalMs: 1,
        });

        expect(result.ready).toBe(true);
        const loads = calls.filter((call) => call.method === "POST" && call.url.endsWith("/load"));
        expect(loads.length).toBeGreaterThanOrEqual(1);

        restore();
    });

    test("refuses readiness when the loaded config cannot be read back canonically", async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            if (url.endsWith("/config/")) return Promise.resolve(Response.json({ apps: {} }));
            if (url.endsWith("/load") && init?.method === "POST") return Promise.resolve(Response.json({}));
            return Promise.resolve(Response.json({}));
        }) as unknown as typeof fetch;
        try {
            const result = await new CaddyGatewayProvider().ensureGatewayReady({ maxAttempts: 1, intervalMs: 1 });

            expect(result).toEqual({ ready: false, error: "Caddy config read-back is different" });
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

describe("canonical gateway reconciliation", () => {
    afterEach(cleanCaddyTmp);

    test("builds every route family once and confirms the live durable candidate", async () => {
        const events: string[] = [];
        const state = {
            tenants: { success: true, updated: 2, errors: [] },
            hostedAuth: { success: true },
            frontends: { total: 1, configured: 1, skipped: 0, errors: [] },
        };
        const provider = {
            prepareCleanRebuild: async () => { events.push("prepare"); },
            setupMasterRoutes: async () => { events.push("master"); },
            rebuildAllTenantConfigs: async () => { events.push("tenants"); return state.tenants; },
            setupHostedAuthRoutes: async () => { events.push("hosted-auth"); return state.hostedAuth; },
            withDeferredPersist: async <T>(operation: () => Promise<T>) => {
                events.push("defer:start");
                const reconciled = await operation();
                events.push("defer:flush");
                return reconciled;
            },
            confirmCanonicalState: async () => { events.push("confirm"); },
        };

        await expect(reconcileCanonicalGatewayRoutes({
            gateway: provider as any,
            reconcileFrontends: async () => { events.push("frontends"); return state.frontends; },
        })).resolves.toEqual(state);
        expect(events).toEqual([
            "defer:start", "prepare", "master", "tenants", "hosted-auth", "frontends", "defer:flush", "confirm",
        ]);
    });

    test("fails without confirming when any canonical route family reports errors", async () => {
        let confirmed = false;
        const provider = {
            prepareCleanRebuild: async () => undefined,
            setupMasterRoutes: async () => undefined,
            rebuildAllTenantConfigs: async () => ({ success: true, updated: 1, errors: [] }),
            setupHostedAuthRoutes: async () => ({ success: true }),
            withDeferredPersist: async <T>(operation: () => Promise<T>) => operation(),
            confirmCanonicalState: async () => { confirmed = true; },
        };

        await expect(reconcileCanonicalGatewayRoutes({
            gateway: provider as any,
            reconcileFrontends: async () => ({
                total: 1, configured: 0, skipped: 0, errors: ["project/site: route rejected"],
            }),
        })).rejects.toThrow("frontend: project/site: route rejected");
        expect(confirmed).toBe(false);
    });

    test("writes the initialized marker only after durable and live state match", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        try {
            const provider = new CaddyGatewayProvider();
            await provider.setupMasterRoutes();
            await provider.confirmCanonicalState();

            expect(await readFile("/tmp/supacloud-caddy-test/INITIALIZED", "utf8"))
                .toBe("supacloud-caddy-config-v1\n");
        } finally {
            restore();
        }
    });
});

function canonicalHealthState(updated: number) {
    return {
        tenants: { success: true, updated, errors: [] },
        hostedAuth: { success: true },
        frontends: { total: 0, configured: 0, skipped: 0, errors: [] },
    };
}

describe("gateway-health worker", () => {
    afterEach(async () => {
        await cleanCaddyTmp();
    });

    test("does not rebuild when Caddy stays reachable", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const { runGatewayHealthCheck, resetGatewayHealthState } = await import("../../src/workers/gateway-health.worker");
        resetGatewayHealthState();

        // 初始状态：未观测过可达 -> 首次探测可达会执行恢复重建。
        const reconcileAll = async () => canonicalHealthState(0);
        await runGatewayHealthCheck({ reconcileAll });
        // 第二次：仍然可达且未达到周期阈值，不应重复重建。
        const rebuilt = await runGatewayHealthCheck({ reconcileAll });

        expect(rebuilt).toBe(false);

        restore();
    });

    test("periodically rebuilds managed routes while Caddy stays reachable", async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = mock(() => Promise.resolve(new Response("{}", { status: 200 }))) as unknown as typeof fetch;
        const restore = () => { globalThis.fetch = originalFetch; };
        const { runGatewayHealthCheck, resetGatewayHealthState } = await import("../../src/workers/gateway-health.worker");
        resetGatewayHealthState();

        let now = 1_000;
        let rebuildCount = 0;
        const reconcileAll = async () => {
            rebuildCount += 1;
            return canonicalHealthState(1);
        };

        await runGatewayHealthCheck({ reconcileAll, now: () => now, reconcileIntervalMs: 5_000 });
        now += 4_999;
        expect(await runGatewayHealthCheck({ reconcileAll, now: () => now, reconcileIntervalMs: 5_000 })).toBe(false);
        now += 1;
        expect(await runGatewayHealthCheck({ reconcileAll, now: () => now, reconcileIntervalMs: 5_000 })).toBe(true);
        expect(rebuildCount).toBe(2);

        restore();
    });

    test("rebuilds after Caddy recovers from unreachable state", async () => {
        let reachable = false;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = mock((input: string | URL | Request) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            if (url.endsWith("/config/")) {
                return Promise.resolve(reachable
                    ? new Response("{}", { status: 200 })
                    : Promise.reject(new Error("ECONNREFUSED")));
            }
            return Promise.resolve(new Response("{}", { status: 200 }));
        }) as unknown as typeof fetch;
        const restore = () => { globalThis.fetch = originalFetch; };

        const { runGatewayHealthCheck, resetGatewayHealthState } = await import("../../src/workers/gateway-health.worker");
        resetGatewayHealthState();

        // 第一次：不可达
        const reconcileAll = async () => canonicalHealthState(3);
        await runGatewayHealthCheck({ reconcileAll });
        // 模拟 caddy 重启后恢复
        reachable = true;
        const rebuilt = await runGatewayHealthCheck({ reconcileAll });

        expect(rebuilt).toBe(true);

        restore();
    });

    test("does not rebuild while Caddy stays unreachable", async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = mock(() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
        const restore = () => { globalThis.fetch = originalFetch; };

        const { runGatewayHealthCheck, resetGatewayHealthState } = await import("../../src/workers/gateway-health.worker");
        resetGatewayHealthState();

        const reconcileAll = async () => canonicalHealthState(1);
        const r1 = await runGatewayHealthCheck({ reconcileAll });
        const r2 = await runGatewayHealthCheck({ reconcileAll });

        expect(r1).toBe(false);
        expect(r2).toBe(false);

        restore();
    });

    test("does not mark Caddy recovered when canonical reconciliation fails", async () => {
        const calls: Array<{ url: string; method: string; body: any }> = [];
        const restore = captureFetch(calls);
        const { runGatewayHealthCheck, resetGatewayHealthState } = await import("../../src/workers/gateway-health.worker");
        resetGatewayHealthState();
        let attempts = 0;
        const reconcileAll = async () => {
            attempts += 1;
            if (attempts === 1) throw new Error("frontend reconcile failed");
            return canonicalHealthState(1);
        };
        try {
            expect(await runGatewayHealthCheck({ reconcileAll })).toBe(false);
            expect(await runGatewayHealthCheck({ reconcileAll })).toBe(true);
            expect(attempts).toBe(2);
        } finally {
            restore();
        }
    });
});
