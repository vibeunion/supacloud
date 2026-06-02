import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { config } from "../../src/config";
import {
    CaddyGatewayProvider,
    DEFAULT_CORS_HEADERS,
    buildTenantCorsOrigins,
    gatewayService,
} from "../../src/services/gateway.service";

function captureFetch(calls: Array<{ url: string; method: string; body: any }>) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const method = init?.method || "GET";
        let body: any = null;
        if (typeof init?.body === "string" && init.body.length > 0) {
            try { body = JSON.parse(init.body); } catch { body = init.body; }
        }
        calls.push({ url, method, body });
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
        expect(DEFAULT_CORS_HEADERS).toContain("x-supacloud-idempotency-key");
        expect(DEFAULT_CORS_HEADERS).toContain("x-supacloud-function-version");
        expect(DEFAULT_CORS_HEADERS).toContain("x-supacloud-trace-id");
        expect(DEFAULT_CORS_HEADERS).toContain("x-supacloud-correlation-id");
        expect(DEFAULT_CORS_HEADERS).toContain("x-supacloud-business-task-id");
        expect(DEFAULT_CORS_HEADERS).toContain("x-supacloud-task-metadata");
        expect(DEFAULT_CORS_HEADERS).toContain("x-forwarded-for");
        expect(DEFAULT_CORS_HEADERS).toContain("x-forwarded-host");
        expect(DEFAULT_CORS_HEADERS).toContain("x-forwarded-proto");
        expect(DEFAULT_CORS_HEADERS).toContain("x-real-ip");
    });

    test("tenant cors origins include exact api and studio custom domains", () => {
        const origins = buildTenantCorsOrigins("dbbabyref", {
            api_domain: "sapi.dbbaby.top",
            auth_domain: "auth.dbbaby.top",
            studio_domain: "sadmin.dbbaby.top",
        });

        expect(origins).toContain("https://sapi.dbbaby.top");
        expect(origins).toContain("https://auth.dbbaby.top");
        expect(origins).toContain("https://sadmin.dbbaby.top");
    });
});

describe("CaddyGatewayProvider", () => {
    afterEach(async () => {
        await cleanCaddyTmp();
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
        expect(load?.body?.apps?.tls?.automation?.policies?.[0]?.key_type).toBe("p256");
        const notice = await readFile("/tmp/supacloud-caddy-test/DO-NOT-EDIT.txt", "utf8");
        expect(notice).toContain("Do not edit /tmp/supacloud-caddy-test/config.json by hand.");
        expect(notice).toContain("Change via: supacloud CLI, SupaCloud management API, SupaCloud web console.");
        const routes = load?.body?.apps?.http?.servers?.supacloud?.routes ?? [];
        const rest = routes.find((route: any) => route["@id"] === "route-project-testref123-rest");
        const storage = routes.find((route: any) => route["@id"] === "route-project-testref123-storage");
        const functions = routes.find((route: any) => route["@id"] === "route-project-testref123-functions");
        const realtime = routes.find((route: any) => route["@id"] === "route-project-testref123-realtime");
        const management = routes.find((route: any) => route["@id"] === "route-project-testref123-management");

        expect(rest?.match?.[0]?.path).toEqual(["/rest/v1*"]);
        expect(rest?.handle?.some((handler: any) => handler.strip_path_prefix === "/rest/v1")).toBe(true);
        expect(rest?.handle?.at(-1)?.headers?.request?.set?.["X-Project-Ref"]).toEqual(["testref123"]);
        const reverseProxyHandlers = findReverseProxyHandlers(routes);
        expect(reverseProxyHandlers.every((handler: any) => !handler.upstreams?.[0]?.dial?.includes("/"))).toBe(true);
        for (const handler of reverseProxyHandlers) {
            const routeId = findRouteIdForHandler(routes, handler);
            const isStorageRoute = routeId?.endsWith("-storage");
            if (isStorageRoute) {
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
        expect(functions?.match?.[0]?.path).toEqual(["/functions/v1*"]);
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

        expect(rest?.match?.[0]?.host).not.toContain("auth.example.com");
        expect(auth?.match?.[0]?.host).toEqual(["auth.example.com"]);
        expect(auth?.match?.[0]?.path).toEqual(["/auth/v1*"]);
        expect(auth?.handle?.some((handler: any) => handler.strip_path_prefix === "/auth/v1")).toBe(true);
        expect(wellKnown?.match?.[0]?.host).toEqual(["auth.example.com"]);
        expect(wellKnown?.match?.[0]?.path).toEqual(["/.well-known/oauth-authorization-server/auth/v1*"]);

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
        const apiRoute = routes.find((item: any) => item["@id"] === "route-project-proj123-functions");
        const corsSubroute = findCorsSubroute(apiRoute);
        const exactMatcher = corsSubroute?.routes?.[0]?.match?.find((matcher: any) => matcher.header?.Origin);
        expect(exactMatcher?.header?.Origin).toContain("https://site.example.com");
        expect(exactMatcher?.header?.Origin).toContain("https://www.example.com");
        expect(exactMatcher?.header?.Origin).toContain("https://api.example.com");

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
        const functionsRoute = routes.find((item: any) => item["@id"] === "route-project-proj123-functions");
        const corsSubroute = findCorsSubroute(functionsRoute);
        const exactMatcher = corsSubroute?.routes?.[0]?.match?.find((matcher: any) => matcher.header?.Origin);
        expect(exactMatcher?.header?.Origin).toContain("https://app.example.com");
        expect(exactMatcher?.header?.Origin).toContain("https://api.example.com");

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
        const tryFiles = subroute?.routes?.find((item: any) => item.match?.[0]?.file?.try_files?.includes("/index.html"))?.match?.[0]?.file;
        const avifRoute = subroute?.routes?.find((item: any) => item.match?.[0]?.header?.Accept?.includes("*image/avif*"));
        const webpRoute = subroute?.routes?.find((item: any) => item.match?.[0]?.header?.Accept?.includes("*image/webp*"));
        const fileServer = subroute?.routes?.at(-1)?.handle?.at(-1);

        expect(route?.match?.[0]?.host).toEqual(["static.example.com"]);
        expect(securityHeaders?.response?.set?.["Strict-Transport-Security"]).toBeUndefined();
        expect(securityHeaders?.response?.set?.["X-Content-Type-Options"]).toEqual(["nosniff"]);
        expect(securityHeaders?.response?.set?.["Referrer-Policy"]).toEqual(["strict-origin-when-cross-origin"]);
        expect(encode?.prefer).toEqual(["zstd", "gzip"]);
        expect(tryFiles?.try_files).toContain("/index.html");
        expect(avifRoute?.match?.[0]?.file?.try_files).toEqual(["{http.request.uri.path}.avif"]);
        expect(webpRoute?.match?.[0]?.file?.try_files).toEqual(["{http.request.uri.path}.webp"]);
        expect(fileServer?.handler).toBe("file_server");
        expect(fileServer?.root).toBe("/var/supacloud/frontends/proj123/0000002b/build");
        expect(fileServer?.precompressed).toEqual({ br: {}, zstd: {}, gzip: {} });

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

        expect(rateLimit).toBeDefined();
        expect(zones.some((zone) => zone.window === "1s" && zone.max_events === 7)).toBe(true);
        expect(zones.some((zone) => zone.window === "1m" && zone.max_events === 70)).toBe(true);
        expect(zones.some((zone) => zone.window === "1h" && zone.max_events === 700)).toBe(true);

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

        expect(routes[0]?.["@id"]).toStartWith("route-custom-testref123-");
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

        expect(routes.some((route: any) => route["@id"] === "route-project-persistref-rest")).toBe(true);
        expect(certs.length).toBeGreaterThan(0);

        restore();
    });
});
