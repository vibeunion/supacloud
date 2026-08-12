import { expect, test } from "bun:test";
import {
    mutationRequestFingerprint,
    verifiedMutationReadback,
} from "./mutation-protocol";

const MUTATION_ID = "00000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-08-11T00:00:00.000Z";
const UPDATED_AT = "2026-08-11T00:00:00.001Z";

function mutationStatus(
    principal: { type: string; id: string },
    overrides: Record<string, unknown> = {},
) {
    return {
        project_ref: "proj",
        mutation_id: MUTATION_ID,
        operation: "scheduled_functions.create",
        resource_key: null,
        request_fingerprint: "a".repeat(64),
        principal,
        status: "succeeded",
        checkpoint: {},
        receipt: {},
        response_status: 200,
        failure_code: null,
        lease: { owner: null, expires_at: null, fencing_epoch: 1 },
        completed_at: UPDATED_AT,
        created_at: CREATED_AT,
        updated_at: UPDATED_AT,
        ...overrides,
    };
}

function mutationHttp(
    principal: { type: string; id: string },
    overrides: Record<string, unknown> = {},
) {
    return {
        get: async () => ({
            ok: true,
            status: 200,
            data: { project_ref: "proj", mutation: mutationStatus(principal, overrides) },
        }),
    };
}

function canonicalResourceKey(resourceId: string): string {
    return `v1/edge-function/${Buffer.from(resourceId, "utf8").toString("base64url")}`;
}

test("Mutation fingerprints are stable across object key order and cover exact values", () => {
    const first = mutationRequestFingerprint({
        operation: "scheduled_functions.create", project_ref: "proj",
        mutation_id: "00000000-0000-4000-8000-000000000001",
        name: "夜班", slug: "worker", cron: "0 2 * * *", method: "POST",
        body: { z: null, a: [true, 2, "é"] },
        headers: { "x-z": "last", "x-a": "first" },
    });
    const reordered = mutationRequestFingerprint({
        body: { a: [true, 2, "é"], z: null }, method: "POST",
        headers: { "x-a": "first", "x-z": "last" }, cron: "0 2 * * *",
        slug: "worker", name: "夜班",
        mutation_id: "00000000-0000-4000-8000-000000000001", project_ref: "proj",
        operation: "scheduled_functions.create",
    });
    const changed = mutationRequestFingerprint({
        operation: "scheduled_functions.create", project_ref: "proj",
        mutation_id: "00000000-0000-4000-8000-000000000001",
        name: "夜班", slug: "worker", cron: "0 2 * * *", method: "POST",
        body: { z: null, a: [true, 3, "é"] },
        headers: { "x-z": "last", "x-a": "first" },
    });

    expect(first).toBe(reordered);
    expect(first).not.toBe(changed);
    expect(first).toBe("4ea6441de7a05686e3dada9aa2ca3cde155a42d4d7b459a9137c557c11261b80");
});

test("Mutation fingerprints reject non-JSON and cyclic request values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => mutationRequestFingerprint({ missing: undefined })).toThrow("bounded JSON");
    expect(() => mutationRequestFingerprint({ invalid: Number.NaN })).toThrow("bounded JSON");
    expect(() => mutationRequestFingerprint({ date: new Date() })).toThrow("only JSON objects and arrays");
    expect(() => mutationRequestFingerprint(cyclic)).toThrow("cycles");
});

test("Mutation fingerprints reject request trees deeper than the Management contract", () => {
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 34; depth += 1) nested = { nested };

    expect(() => mutationRequestFingerprint(nested)).toThrow("bounded JSON");
});

test("Verified mutation readback binds the project CLI to its exact project principal", async () => {
    const readback = await verifiedMutationReadback(mutationHttp({
        type: "project", id: "project:proj",
    }) as never, {
        ref: "proj",
        mutationId: MUTATION_ID,
        operation: "scheduled_functions.create",
        requestFingerprint: "a".repeat(64),
    });

    expect(readback.kind).toBe("available");
});

test.each([
    ["a one-byte id", canonicalResourceKey("a")],
    ["an ordinary Unicode id", canonicalResourceKey("夜班/worker")],
    ["a 128-byte id", canonicalResourceKey("界".repeat(42) + "é")],
])("Verified mutation readback accepts a canonical resource key with %s", async (_case, resourceKey) => {
    const readback = await verifiedMutationReadback(mutationHttp({
        type: "project", id: "project:proj",
    }, { resource_key: resourceKey }) as never, {
        ref: "proj",
        mutationId: MUTATION_ID,
        operation: "scheduled_functions.create",
        requestFingerprint: "a".repeat(64),
    });

    expect(readback.kind).toBe("available");
});

test.each([
    ["one-character encoding", "v1/edge-function/A"],
    ["non-zero base64url trailing bits", "v1/edge-function/YR"],
    ["non-UTF-8 decoded bytes", "v1/edge-function/_w"],
    ["leading Unicode whitespace", canonicalResourceKey("\u00a0nightly")],
    ["C1 control character", canonicalResourceKey("nightly\u0085")],
    ["129-byte id", canonicalResourceKey("a".repeat(129))],
    ["non-v1 key", "v2/edge-function/YQ"],
    ["non-canonical resource type", "v1/Edge-function/YQ"],
])("Verified mutation readback rejects a resource key with %s", async (_case, resourceKey) => {
    const readback = await verifiedMutationReadback(mutationHttp({
        type: "project", id: "project:proj",
    }, { resource_key: resourceKey }) as never, {
        ref: "proj",
        mutationId: MUTATION_ID,
        operation: "scheduled_functions.create",
        requestFingerprint: "a".repeat(64),
    });

    expect(readback).toEqual({ kind: "invalid" });
});

test.each([
    { type: "project", id: "project:other" },
    { type: "admin", id: "admin" },
    { type: "master", id: "master" },
])("Verified mutation readback rejects a non-matching $type principal", async (principal) => {
    const readback = await verifiedMutationReadback(mutationHttp(principal) as never, {
        ref: "proj",
        mutationId: MUTATION_ID,
        operation: "scheduled_functions.create",
        requestFingerprint: "a".repeat(64),
    });

    expect(readback).toEqual({ kind: "invalid" });
});
