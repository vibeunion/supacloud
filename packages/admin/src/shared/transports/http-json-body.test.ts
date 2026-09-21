import { afterEach, describe, expect, test } from "bun:test";
import { HttpTransport as AdminTransport } from "./http";
import { HttpTransport as CliTransport } from "../../../../cli/src/shared/transports/http";

const originalFetch = globalThis.fetch;
const config = { baseUrl: "https://api.example.test", token: "test-token" };
const admin = new AdminTransport(config);
const cli = new CliTransport(config);
const requests = [
    ["admin POST", (body: unknown) => admin.post("/resource", body)],
    ["admin bounded POST", (body: unknown) => admin.post("/resource", body, { maxJsonBytes: 1024 })],
    ["admin PATCH", (body: unknown) => admin.patch("/resource", body)],
    ["admin PUT", (body: unknown) => admin.put("/resource", body)],
    ["cli POST", (body: unknown) => cli.post("/resource", body)],
    ["cli bounded POST", (body: unknown) => cli.post("/resource", body, { maxJsonBytes: 1024 })],
    ["cli PATCH", (body: unknown) => cli.patch("/resource", body)],
    ["cli PUT", (body: unknown) => cli.put("/resource", body)],
    ["cli DELETE", (body: unknown) => cli.delete("/resource", body)],
    ["cli release POST", (body: unknown) => cli.postReleaseMutation("/resource", body)],
    ["cli release PATCH", (body: unknown) => cli.patchReleaseMutation("/resource", body)],
    ["cli release DELETE", (body: unknown) => cli.deleteReleaseMutation("/resource", body)],
] as const;

afterEach(() => { globalThis.fetch = originalFetch; });

describe.each(requests)("%s JSON request boundary", (_name, request) => {
    test.each([false, 0, null, "", { enabled: false }, [0]])(
        "preserves JSON input %j",
        async (body) => {
            const bodies: unknown[] = [];
            globalThis.fetch = Object.assign(
                async (_input: string | URL | Request, init?: RequestInit) => {
                    bodies.push(init?.body);
                    return Response.json({ accepted: true });
                },
                { preconnect: originalFetch.preconnect },
            );
            expect((await request(body)).ok).toBe(true);
            expect(bodies).toEqual([JSON.stringify(body)]);
        },
    );

    test("omits only an absent request body", async () => {
        const hasBody: boolean[] = [];
        globalThis.fetch = Object.assign(
            async (_input: string | URL | Request, init?: RequestInit) => {
                hasBody.push(init !== undefined && Object.hasOwn(init, "body"));
                return Response.json({ accepted: true });
            },
            { preconnect: originalFetch.preconnect },
        );
        expect((await request(undefined)).ok).toBe(true);
        expect(hasBody).toEqual([false]);
    });

    test("rejects unserializable bodies without starting a request", async () => {
        let calls = 0;
        globalThis.fetch = Object.assign(
            async () => {
                calls++;
                return Response.json({ accepted: true });
            },
            { preconnect: originalFetch.preconnect },
        );
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        for (const body of [Symbol("invalid"), () => 1, 1n, cycle, { toJSON: () => undefined }]) {
            const result = await request(body).catch(() => null);
            expect(result?.ok ?? false).toBe(false);
        }
        expect(calls).toBe(0);
    });
});
