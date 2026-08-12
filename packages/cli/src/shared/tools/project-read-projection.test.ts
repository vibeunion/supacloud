import { describe, expect, test } from "bun:test";
import {
    PROJECT_READ_RESPONSE_MAX_BYTES,
    projectGetRead,
    projectListRead,
    type ProjectReadResult,
} from "./project-read-projection";

const PROJECT_REF = "abcdefghijklmnopqrst";
const PROJECT_SUMMARY = {
    id: "11111111-1111-4111-8111-111111111111",
    ref: PROJECT_REF,
    organization_id: "22222222-2222-4222-8222-222222222222",
    organization_slug: "example-organization",
    name: "Example project",
    region: "local",
    created_at: "2026-08-12T00:00:00.000Z",
    status: "ACTIVE_HEALTHY",
};
const PROJECT_DETAILS = {
    ...PROJECT_SUMMARY,
    database: {
        host: "db.example.test",
        version: "17.5",
        postgres_engine: "17",
        release_channel: "stable",
    },
    api: { url: "https://api.example.test" },
    studio: { url: "https://studio.example.test" },
};

function expectFailure(readResult: ProjectReadResult, message: string, sentinel?: string): void {
    expect(readResult).toEqual({ text: `❌ ${message}`, isError: true });
    if (sentinel) expect(readResult.text).not.toContain(sentinel);
}

describe("project read projection", () => {
    test("projects exact list metadata and accepts an empty list", () => {
        const listRead = projectListRead({ ok: true, status: 200, data: [PROJECT_SUMMARY] });
        const emptyRead = projectListRead({ ok: true, status: 200, data: [] });

        expect(listRead.isError).toBe(false);
        expect(JSON.parse(listRead.text)).toEqual([PROJECT_SUMMARY]);
        expect(emptyRead).toEqual({ text: "[]", isError: false });
    });

    test("projects the current Management get contract and drops known private sections", () => {
        const remoteSecret = "known-private-section-sentinel";
        const readResult = projectGetRead({
            ok: true,
            status: 200,
            data: {
                ...PROJECT_DETAILS,
                config: { scheduled_functions: [], private_runtime_value: remoteSecret },
                anon_key: remoteSecret,
                services: [{ id: "db", token: remoteSecret }],
            },
        }, PROJECT_REF);

        expect(readResult.isError).toBe(false);
        expect(JSON.parse(readResult.text)).toEqual(PROJECT_DETAILS);
        expect(readResult.text).not.toContain(remoteSecret);
        expect(readResult.text).not.toContain("config");
        expect(readResult.text).not.toContain("anon_key");
        expect(readResult.text).not.toContain("services");
    });

    test("accepts optional endpoints only as canonical origin metadata", () => {
        const withoutEndpoints = projectGetRead({
            ok: true,
            status: 200,
            data: {
                ...PROJECT_SUMMARY,
                database: PROJECT_DETAILS.database,
                config: {},
                services: [],
            },
        }, PROJECT_REF);
        const normalizedOrigins = projectGetRead({
            ok: true,
            status: 200,
            data: {
                ...PROJECT_DETAILS,
                api: { url: "https://API.Example.Test:8443" },
                studio: { url: "http://STUDIO.Example.Test" },
            },
        }, PROJECT_REF);

        expect(JSON.parse(withoutEndpoints.text)).toEqual({
            ...PROJECT_SUMMARY,
            database: PROJECT_DETAILS.database,
        });
        expect(JSON.parse(normalizedOrigins.text)).toEqual({
            ...PROJECT_DETAILS,
            api: { url: "https://api.example.test:8443" },
            studio: { url: "http://studio.example.test" },
        });
    });

    test.each([
        ["root path", "https://api.example.test/"],
        ["path", "https://api.example.test/private-path"],
        ["encoded path", "https://api.example.test/%2e"],
        ["query", "https://api.example.test?token=private"],
        ["fragment", "https://api.example.test#private"],
        ["credentials", "https://user:password@api.example.test"],
        ["backslash", "https://api.example.test\\private"],
    ])("rejects an endpoint URL containing %s without reflection", (_label, endpointUrl) => {
        const readResult = projectGetRead({
            ok: true,
            status: 200,
            data: { ...PROJECT_DETAILS, api: { url: endpointUrl } },
        }, PROJECT_REF);

        expectFailure(readResult, "Invalid project response", endpointUrl);
    });

    test("rejects non-2xx and inconsistent HTTP results without reflecting bodies", () => {
        const remoteSecret = "http-failure-private-sentinel";
        const failures = [
            projectListRead({
                ok: false,
                status: 404,
                data: { error: remoteSecret, service_role_key: remoteSecret },
            }),
            projectGetRead({
                ok: true,
                status: 503,
                data: { ...PROJECT_DETAILS, secret: remoteSecret },
            }, PROJECT_REF),
            projectGetRead({
                ok: false,
                status: 200,
                data: { ...PROJECT_DETAILS, secret: remoteSecret },
            }, PROJECT_REF),
            projectListRead({
                ok: false,
                status: Number.NaN,
                data: { error: remoteSecret },
            }),
        ];

        expectFailure(failures[0], "Project list request failed (404)", remoteSecret);
        expectFailure(failures[1], "Project get request failed (503)", remoteSecret);
        expectFailure(failures[2], "Project get request failed (200)", remoteSecret);
        expectFailure(failures[3], "Project list request failed", remoteSecret);
    });

    test("rejects malformed, duplicate, and cross-project payloads", () => {
        const remoteSecret = "invalid-project-private-sentinel";
        const malformed = projectListRead({
            ok: true,
            status: 200,
            data: [{ ...PROJECT_SUMMARY, created_at: remoteSecret }],
        });
        const duplicateId = projectListRead({
            ok: true,
            status: 200,
            data: [
                PROJECT_SUMMARY,
                { ...PROJECT_SUMMARY, ref: "different-project" },
            ],
        });
        const duplicateRef = projectListRead({
            ok: true,
            status: 200,
            data: [
                PROJECT_SUMMARY,
                { ...PROJECT_SUMMARY, id: "33333333-3333-4333-8333-333333333333" },
            ],
        });
        const crossProject = projectGetRead({
            ok: true,
            status: 200,
            data: { ...PROJECT_DETAILS, ref: "different-project" },
        }, PROJECT_REF);

        expectFailure(malformed, "Invalid project list response", remoteSecret);
        expectFailure(duplicateId, "Invalid project list response");
        expectFailure(duplicateRef, "Invalid project list response");
        expectFailure(crossProject, "Invalid project response");
    });

    test.each([
        ["list top level", [{ ...PROJECT_SUMMARY, credentials: { service_role_key: "unknown-field-sentinel" } }]],
        ["get top level", { ...PROJECT_DETAILS, secret_key: "unknown-field-sentinel" }],
        ["database", {
            ...PROJECT_DETAILS,
            database: { ...PROJECT_DETAILS.database, password: "unknown-field-sentinel" },
        }],
        ["api", {
            ...PROJECT_DETAILS,
            api: { ...PROJECT_DETAILS.api, token: "unknown-field-sentinel" },
        }],
        ["studio", {
            ...PROJECT_DETAILS,
            studio: { ...PROJECT_DETAILS.studio, token: "unknown-field-sentinel" },
        }],
    ])("rejects unknown %s fields without reflecting them", (location, payload) => {
        const readResult = location === "list top level"
            ? projectListRead({ ok: true, status: 200, data: payload })
            : projectGetRead({ ok: true, status: 200, data: payload }, PROJECT_REF);

        expectFailure(
            readResult,
            location === "list top level" ? "Invalid project list response" : "Invalid project response",
            "unknown-field-sentinel",
        );
    });

    test("rejects non-string and ill-formed Unicode fields", () => {
        const numericRef = projectListRead({
            ok: true,
            status: 200,
            data: [{ ...PROJECT_SUMMARY, ref: 12345 }],
        });
        const loneSurrogate = projectGetRead({
            ok: true,
            status: 200,
            data: { ...PROJECT_DETAILS, name: "invalid-name-\uD800" },
        }, PROJECT_REF);

        expectFailure(numericRef, "Invalid project list response");
        expectFailure(loneSurrogate, "Invalid project response");
    });

    test("rejects oversized list and detail payloads without reflecting allowed fields", () => {
        const oversizedList = Array.from({ length: 5_000 }, (_, index) => ({
            ...PROJECT_SUMMARY,
            id: `project-id-${index}`,
            ref: `project-${index}`,
        }));
        const oversizedSecret = "oversized-private-sentinel".repeat(50_000);
        const listRead = projectListRead({ ok: true, status: 200, data: oversizedList });
        const getRead = projectGetRead({
            ok: true,
            status: 200,
            data: {
                ...PROJECT_DETAILS,
                config: { retained_contract_field: oversizedSecret },
            },
        }, PROJECT_REF);

        expect(new TextEncoder().encode(JSON.stringify(oversizedList)).byteLength)
            .toBeGreaterThan(PROJECT_READ_RESPONSE_MAX_BYTES);
        expectFailure(listRead, "Invalid project list response");
        expectFailure(getRead, "Invalid project response", "oversized-private-sentinel");
    });
});
