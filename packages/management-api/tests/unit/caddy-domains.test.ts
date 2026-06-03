import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isCaddyRouteDomain, isCaddyTlsBlockedDomain, normalizeCaddyHost } from "../../src/utils/caddy-domains";

const fixturePath = "/tmp/supacloud-caddy-test/caddy-domains/config.json";

afterEach(async () => {
  await rm(dirname(fixturePath), { recursive: true, force: true });
});

describe("isCaddyRouteDomain", () => {
  test("allows hosts already registered in persisted Caddy routes", async () => {
    await mkdir(dirname(fixturePath), { recursive: true });
    await writeFile(fixturePath, JSON.stringify({
      apps: {
        http: {
          servers: {
            supacloud: {
              routes: [
                {
                  "@id": "route-auth-login",
                  match: [{ host: ["auth.ai.xigu.org"], path: ["/", "/login.html"] }],
                  handle: [{ handler: "static_response", body: "ok" }],
                },
              ],
            },
          },
        },
      },
    }));

    await expect(isCaddyRouteDomain("https://auth.ai.xigu.org:443", fixturePath)).resolves.toBe(true);
  });

  test("allows hosts registered on nested subroutes", async () => {
    await mkdir(dirname(fixturePath), { recursive: true });
    await writeFile(fixturePath, JSON.stringify({
      apps: {
        http: {
          servers: {
            supacloud: {
              routes: [
                {
                  handle: [{
                    handler: "subroute",
                    routes: [
                      {
                        match: [{ host: ["api.ai.xigu.org"], path: ["/auth/v1*"] }],
                        handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:9999" }] }],
                      },
                    ],
                  }],
                },
              ],
            },
          },
        },
      },
    }));

    await expect(isCaddyRouteDomain("api.ai.xigu.org", fixturePath)).resolves.toBe(true);
  });

  test("rejects missing or unregistered domains", async () => {
    await expect(isCaddyRouteDomain("unknown.ai.xigu.org", fixturePath)).resolves.toBe(false);
  });
});

describe("isCaddyTlsBlockedDomain", () => {
  test("normalizes ask endpoint host values", () => {
    expect(normalizeCaddyHost(" HTTPS://WWW.Example.COM:443. ")).toBe("www.example.com");
  });

  test("blocks exact denylisted domains and their subdomains", () => {
    const blocked = ["blocked.example.com", "root.test"];

    expect(isCaddyTlsBlockedDomain("blocked.example.com", blocked)).toBe(true);
    expect(isCaddyTlsBlockedDomain("api.blocked.example.com", blocked)).toBe(true);
    expect(isCaddyTlsBlockedDomain("root.test", blocked)).toBe(true);
    expect(isCaddyTlsBlockedDomain("www.root.test", blocked)).toBe(true);
  });

  test("does not block lookalike suffixes", () => {
    const blocked = ["example.com"];

    expect(isCaddyTlsBlockedDomain("badexample.com", blocked)).toBe(false);
    expect(isCaddyTlsBlockedDomain("example.com.evil.test", blocked)).toBe(false);
    expect(isCaddyTlsBlockedDomain("allowed.test", blocked)).toBe(false);
  });
});
