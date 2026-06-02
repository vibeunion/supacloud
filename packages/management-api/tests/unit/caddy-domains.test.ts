import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isCaddyRouteDomain } from "../../src/utils/caddy-domains";

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
