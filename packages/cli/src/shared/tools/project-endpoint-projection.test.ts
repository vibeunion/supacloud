import { describe, expect, test } from "bun:test";
import {
    projectEndpointListRead,
    projectEndpointsRead,
} from "./project-endpoint-projection";

const PROJECT_REF = "abcdefghijklmnopqrst";

function projection(overrides: Record<string, unknown> = {}) {
    return {
        schema: "supacloud.project-endpoints.v1",
        project_ref: PROJECT_REF,
        project_name: "Example project",
        project_status: "ACTIVE_HEALTHY",
        endpoints: {
            api: {
                origin: "https://api.example.test",
                host: "api.example.test",
                aliases: ["canonical.example.test"],
                source: "explicit",
                status: "configured",
                verification: "not_checked",
            },
            auth: {
                origin: "https://auth.example.test",
                host: "auth.example.test",
                aliases: [],
                source: "explicit",
                status: "configured",
                verification: "not_checked",
            },
            studio: {
                origin: "https://studio.example.test",
                host: "studio.example.test",
                aliases: [],
                source: "derived",
                status: "configured",
                verification: "not_checked",
            },
        },
        ...overrides,
    };
}

function result(data: unknown, status = 200) {
    return { ok: status >= 200 && status < 300, status, data } as any;
}

describe("project endpoint read projection", () => {
    test("accepts the fixed endpoint projection", () => {
        const read = projectEndpointsRead(result(projection()), PROJECT_REF);
        expect(read.isError).toBe(false);
        expect(JSON.parse(read.text)).toEqual(projection());
    });

    test("rejects cross-project and secret-bearing responses without reflecting content", () => {
        const sentinel = "private-endpoint-sentinel";
        for (const candidate of [
            projection({ project_ref: "different-project" }),
            { ...projection(), private_config: sentinel },
            {
                ...projection(),
                endpoints: {
                    ...(projection().endpoints as Record<string, unknown>),
                    api: {
                        ...(projection().endpoints as any).api,
                        credential: sentinel,
                    },
                },
            },
        ]) {
            const read = projectEndpointsRead(result(candidate), PROJECT_REF);
            expect(read.isError).toBe(true);
            expect(read.text).toContain("Invalid project endpoints response");
            expect(read.text).not.toContain(sentinel);
        }
    });

    test("accepts a unique platform list and rejects duplicate refs", () => {
        const valid = projectEndpointListRead(result([projection()]));
        expect(valid.isError).toBe(false);
        expect(JSON.parse(valid.text)).toEqual([projection()]);

        const invalid = projectEndpointListRead(result([projection(), projection()]));
        expect(invalid.isError).toBe(true);
        expect(invalid.text).toContain("Invalid project endpoint list response");
    });
});
