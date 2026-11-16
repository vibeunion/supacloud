import { describe, expect, test } from "bun:test";
import { isolateCaddyCachePaths } from "../../src/services/caddy-startup-preflight";

function atPath(value: unknown, path: string[]): unknown {
    let current = value;
    for (const key of path) {
        if (Array.isArray(current)) current = current[Number(key)];
        else if (current && typeof current === "object") current = (current as Record<string, unknown>)[key];
        else return undefined;
    }
    return current;
}

describe("Caddy validation isolation", () => {
    test("rewrites nested Badger cache paths without mutating the candidate", () => {
        const candidate = {
            apps: {
                http: {
                    servers: {
                        supacloud: {
                            routes: [{
                                handle: [{
                                    handler: "cache",
                                    Configuration: {
                                        DefaultCache: {
                                            badger: { found: true, path: "/var/lib/supacloud/caddy/http-cache" },
                                        },
                                    },
                                }],
                            }],
                        },
                    },
                },
            },
        };

        const isolated = isolateCaddyCachePaths(candidate, "/tmp/caddy-validation/http-cache");
        const originalPath = atPath(candidate, ["apps", "http", "servers", "supacloud", "routes", "0", "handle", "0", "Configuration", "DefaultCache", "badger", "path"]);
        const isolatedPath = atPath(isolated, ["apps", "http", "servers", "supacloud", "routes", "0", "handle", "0", "Configuration", "DefaultCache", "badger", "path"]);

        expect(originalPath).toBe("/var/lib/supacloud/caddy/http-cache");
        expect(isolatedPath).toBe("/tmp/caddy-validation/http-cache/0");
    });

    test("rewrites every cache path, including paths with a temporary suffix", () => {
        const isolated = isolateCaddyCachePaths({
            first: { path: "/var/lib/supacloud/caddy/http-cache" },
            second: [{ path: "/var/lib/supacloud/caddy/http-cache-during-upgrade" }],
            unrelated: { path: "/var/lib/supacloud/caddy/certificates" },
        }, "/tmp/caddy-validation/http-cache");

        expect(atPath(isolated, ["first", "path"])).toBe("/tmp/caddy-validation/http-cache/0");
        expect(atPath(isolated, ["second", "0", "path"])).toBe("/tmp/caddy-validation/http-cache/1");
        expect(atPath(isolated, ["unrelated", "path"])).toBe("/var/lib/supacloud/caddy/certificates");
    });
});
