import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    REALTIME_TENANT_SCHEMA_FILE_SHA256,
    REALTIME_TENANT_SCHEMA_TREE_SHA256,
    REALTIME_TENANT_SCHEMA_VERSION,
    assertRealtimeTenantSchemaState,
    decideRealtimeTenantSchema,
    defaultRealtimeTenantSchemaDirectory,
    loadRealtimeTenantSchemaArtifact,
    realtimeTenantSchemaBootstrapSql,
    realtimeTenantSchemaInspectionSql,
} from "../../src/services/realtime-tenant-schema-artifact";

async function copyArtifact(): Promise<string> {
    const source = defaultRealtimeTenantSchemaDirectory();
    const target = await mkdtemp(join(tmpdir(), "realtime-tenant-schema-"));
    const order = (await readFile(join(source, "order.txt"), "utf8")).split("\n").filter(Boolean);
    await writeFile(join(target, "order.txt"), `${order.join("\n")}\n`);
    for (const path of order) {
        const sql = await readFile(join(source, path), "utf8");
        const directory = join(target, path, "..");
        await import("node:fs/promises").then(({ mkdir }) => mkdir(directory, { recursive: true }));
        await writeFile(join(target, path), sql);
    }
    return target;
}

function pinnedState(artifact: Awaited<ReturnType<typeof loadRealtimeTenantSchemaArtifact>>) {
    return {
        schemaExists: true,
        empty: false,
        subscriptionExists: true,
        subscriptionOwner: "supabase_realtime_admin",
        functions: [...artifact.functionBodies].flatMap(([name, bodies]) =>
            bodies.map((prosrcMd5) => ({ name, prosrcMd5, owner: "supabase_realtime_admin" }))),
    };
}

describe("pinned Realtime tenant schema artifact", () => {
    test("loads the pinned runtime and refuses anything else", async () => {
        const artifact = await loadRealtimeTenantSchemaArtifact();
        expect(artifact.version).toBe(REALTIME_TENANT_SCHEMA_VERSION);
        expect(artifact.treeSha256).toBe(REALTIME_TENANT_SCHEMA_TREE_SHA256);
        expect(artifact.files).toHaveLength(REALTIME_TENANT_SCHEMA_FILE_SHA256.size);
        expect(artifact.functionBodies.get("list_changes")).toHaveLength(1);
        expect(artifact.functionBodies.get("check_equality_op")).toHaveLength(2);
    });

    test("a tampered file refuses to load", async () => {
        const directory = await copyArtifact();
        try {
            const target = join(directory, "realtime/functions/list_changes.sql");
            await writeFile(target, `${await readFile(target, "utf8")}\n-- tampered\n`);
            await expect(loadRealtimeTenantSchemaArtifact(directory)).rejects.toThrow(
                /does not match the pinned 2\.150\.0 runtime: realtime\/functions\/list_changes\.sql/,
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("a reordered or incomplete order.txt refuses to load", async () => {
        const directory = await copyArtifact();
        try {
            const orderPath = join(directory, "order.txt");
            const order = (await readFile(orderPath, "utf8")).split("\n").filter(Boolean);
            await writeFile(orderPath, `${[...order].reverse().join("\n")}\n`);
            await expect(loadRealtimeTenantSchemaArtifact(directory)).rejects.toThrow(/tree does not match the pinned/);

            await writeFile(orderPath, `${order.slice(1).join("\n")}\n`);
            await expect(loadRealtimeTenantSchemaArtifact(directory)).rejects.toThrow(/missing pinned files/);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test("the bootstrap replaces the empty schema the tenant migration leaves behind", async () => {
        const artifact = await loadRealtimeTenantSchemaArtifact();
        const sql = realtimeTenantSchemaBootstrapSql(artifact);
        expect(sql.indexOf("DROP SCHEMA IF EXISTS realtime CASCADE")).toBeGreaterThan(sql.indexOf("BEGIN;"));
        expect(sql.indexOf("DROP SCHEMA IF EXISTS realtime CASCADE")).toBeLessThan(sql.indexOf("create schema \"realtime\""));
        expect(sql).toContain("COMMIT;");
        // Every file lands in order.txt order.
        const positions = artifact.files.map((file) => sql.indexOf(`-- ${file.path}`));
        expect(positions.every((position) => position > 0)).toBe(true);
        expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    });

    test("an empty schema is installed and the pinned schema is a no-op", async () => {
        const artifact = await loadRealtimeTenantSchemaArtifact();
        expect(decideRealtimeTenantSchema(artifact, {
            schemaExists: false, empty: true, subscriptionExists: false, subscriptionOwner: null, functions: [],
        })).toEqual({ mode: "install", reason: "the realtime schema is empty" });
        expect(decideRealtimeTenantSchema(artifact, {
            schemaExists: true, empty: true, subscriptionExists: false, subscriptionOwner: null, functions: [],
        }).mode).toBe("install");
        expect(decideRealtimeTenantSchema(artifact, pinnedState(artifact)).mode).toBe("pinned");
    });

    test("a divergent schema is refused instead of overwritten", async () => {
        const artifact = await loadRealtimeTenantSchemaArtifact();
        const pinned = pinnedState(artifact);

        expect(() => decideRealtimeTenantSchema(artifact, { ...pinned, subscriptionExists: false }))
            .toThrow(/no realtime\.subscription table/);
        expect(() => decideRealtimeTenantSchema(artifact, { ...pinned, subscriptionOwner: "postgres" }))
            .toThrow(/realtime\.subscription is owned by postgres/);

        const missing = pinned.functions.filter((entry) => entry.name !== "apply_rls");
        expect(() => decideRealtimeTenantSchema(artifact, { ...pinned, functions: missing }))
            .toThrow(/missing realtime\.apply_rls/);

        const divergent = pinned.functions.map((entry) => entry.name === "list_changes"
            ? { ...entry, prosrcMd5: "0".repeat(32) }
            : entry);
        expect(() => decideRealtimeTenantSchema(artifact, { ...pinned, functions: divergent }))
            .toThrow(/realtime\.list_changes is not the pinned 2\.150\.0 definition/);

        const foreignOwner = pinned.functions.map((entry) => entry.name === "apply_rls"
            ? { ...entry, owner: "postgres" }
            : entry);
        expect(() => decideRealtimeTenantSchema(artifact, { ...pinned, functions: foreignOwner }))
            .toThrow(/owned by postgres/);
    });

    test("the inspection is one read-only query", () => {
        const sql = realtimeTenantSchemaInspectionSql();
        expect(sql).toContain("json_build_object");
        expect(sql).toContain("to_regclass('realtime.subscription')");
        expect(sql).not.toMatch(/drop |create |alter /i);
        expect(() => assertRealtimeTenantSchemaState({ schemaExists: true })).toThrow(/unexpected shape/);
    });
});
