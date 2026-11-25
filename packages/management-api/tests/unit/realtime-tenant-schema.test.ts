import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../../src/config";
import {
  OFFICIAL_REALTIME_APPLY_RLS_SHA256,
  OFFICIAL_REALTIME_LIST_CHANGES_SHA256,
  OFFICIAL_REALTIME_TENANT_SCHEMA_FILES,
  ensureOfficialRealtimeTenantSchema,
  officialRealtimeTenantSchemaSql,
  pinnedRealtimeTenantSchemaArtifact,
  sha256Text,
} from "../../src/db/realtime-tenant-schema";
import {
  REALTIME_TENANT_SCHEMA_FILE_SHA256,
  REALTIME_TENANT_SCHEMA_TREE_SHA256,
  REALTIME_TENANT_SCHEMA_VERSION,
  assertRealtimeTenantSchemaFiles,
  decideRealtimeTenantSchema,
  defaultRealtimeTenantSchemaDirectory,
  readRealtimeTenantSchemaDirectory,
  realtimeTenantSchemaInspectionSql,
  type RealtimeTenantSchemaArtifact,
  type RealtimeTenantSchemaState,
} from "../../src/db/realtime-tenant-schema/artifact";

const schemaDir = defaultRealtimeTenantSchemaDirectory();

function emptyState(): RealtimeTenantSchemaState {
  return {
    schemaExists: true,
    empty: true,
    listChangesPresent: false,
    subscriptionExists: false,
    subscriptionOwner: null,
    functions: [],
  };
}

function pinnedState(artifact: RealtimeTenantSchemaArtifact): RealtimeTenantSchemaState {
  return {
    schemaExists: true,
    empty: false,
    listChangesPresent: true,
    subscriptionExists: true,
    subscriptionOwner: "supabase_realtime_admin",
    functions: [...artifact.functionBodies].flatMap(([name, bodies]) =>
      bodies.map((prosrcMd5) => ({ name, prosrcMd5, owner: "supabase_realtime_admin" })),
    ),
  };
}

async function copyArtifact(): Promise<string> {
  const target = await mkdtemp(join(tmpdir(), "realtime-tenant-schema-"));
  const files = await readRealtimeTenantSchemaDirectory(schemaDir);
  await writeFile(join(target, "order.txt"), `${files.map((file) => file.path).join("\n")}\n`);
  for (const file of files) {
    const directory = join(target, file.path, "..");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(directory, { recursive: true }));
    await writeFile(join(target, file.path), file.sql);
  }
  return target;
}

describe("official realtime tenant schema", () => {
  test("ships one pinned tree for bootstrap and the CDC fixture", async () => {
    const files = new Map(OFFICIAL_REALTIME_TENANT_SCHEMA_FILES);
    const onDisk = await readRealtimeTenantSchemaDirectory(schemaDir);
    const artifact = pinnedRealtimeTenantSchemaArtifact();
    expect(onDisk.map((file) => file.path)).toEqual([...files.keys()]);
    expect(artifact.version).toBe(REALTIME_TENANT_SCHEMA_VERSION);
    expect(artifact.treeSha256).toBe(REALTIME_TENANT_SCHEMA_TREE_SHA256);
    expect(artifact.files).toHaveLength(REALTIME_TENANT_SCHEMA_FILE_SHA256.size);
    expect(artifact.functionBodies.get("list_changes")).toHaveLength(1);
    expect(artifact.functionBodies.get("check_equality_op")).toHaveLength(2);
    for (const file of onDisk) {
      expect(file.sql).toBe(files.get(file.path));
      expect(sha256Text(file.sql)).toBe(REALTIME_TENANT_SCHEMA_FILE_SHA256.get(file.path));
    }
    expect(sha256Text(files.get("realtime/functions/apply_rls.sql") ?? "")).toBe(OFFICIAL_REALTIME_APPLY_RLS_SHA256);
    expect(sha256Text(files.get("realtime/functions/list_changes.sql") ?? "")).toBe(OFFICIAL_REALTIME_LIST_CHANGES_SHA256);
    const pin = JSON.parse(await readFile(join(schemaDir, "artifact.json"), "utf8")) as {
      schemaTreeSha256: string;
      order: string[];
    };
    expect(pin.schemaTreeSha256).toBe(REALTIME_TENANT_SCHEMA_TREE_SHA256);
    expect(pin.order).toEqual([...files.keys()]);
  });

  test("a tampered file or a reordered tree refuses to load", async () => {
    const directory = await copyArtifact();
    try {
      const target = join(directory, "realtime/functions/list_changes.sql");
      await writeFile(target, `${await readFile(target, "utf8")}\n-- tampered\n`);
      await expect(readRealtimeTenantSchemaDirectory(directory).then(assertRealtimeTenantSchemaFiles)).rejects.toThrow(
        /does not match the pinned 2\.150\.0 runtime: realtime\/functions\/list_changes\.sql/,
      );

      const fresh = await copyArtifact();
      try {
        const orderPath = join(fresh, "order.txt");
        const order = (await readFile(orderPath, "utf8")).split("\n").filter(Boolean);
        await writeFile(orderPath, `${[...order].reverse().join("\n")}\n`);
        await expect(readRealtimeTenantSchemaDirectory(fresh).then(assertRealtimeTenantSchemaFiles)).rejects.toThrow(
          /tree does not match the pinned/,
        );
        await writeFile(orderPath, `${order.slice(1).join("\n")}\n`);
        await expect(readRealtimeTenantSchemaDirectory(fresh).then(assertRealtimeTenantSchemaFiles)).rejects.toThrow(
          /missing pinned files/,
        );
      } finally {
        await rm(fresh, { recursive: true, force: true });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not create or drop the realtime schema that supabase.sql already owns", () => {
    const sql = officialRealtimeTenantSchemaSql();
    expect(sql).not.toMatch(/create schema\s+"realtime"/i);
    expect(sql).not.toMatch(/drop schema/i);
    expect(sql).toContain('grant usage on schema "realtime"');
    expect(sql).toContain("function realtime.list_changes");
    expect(sql).toContain("function realtime.apply_rls");
    expect(sql).toContain('create table "realtime"."subscription"');
  });

  test("the catalog receipt is one read-only query", () => {
    const sql = realtimeTenantSchemaInspectionSql();
    expect(sql).toContain("json_build_object");
    expect(sql).toContain("to_regprocedure('realtime.list_changes(name,name,integer,integer)')");
    expect(sql).toContain("to_regclass('realtime.subscription')");
    expect(sql).not.toMatch(/\b(drop|create|alter)\b/i);
  });

  test("an empty schema is installed, an exact pin is a no-op, and an existing list_changes is left alone", () => {
    const artifact = pinnedRealtimeTenantSchemaArtifact();
    expect(decideRealtimeTenantSchema(artifact, emptyState())).toEqual({
      mode: "install",
      reason: "the realtime schema is empty",
    });
    expect(decideRealtimeTenantSchema(artifact, { ...emptyState(), schemaExists: false }).mode).toBe("install");
    expect(decideRealtimeTenantSchema(artifact, pinnedState(artifact))).toEqual({
      mode: "pinned",
      reason: `the realtime schema is the pinned ${REALTIME_TENANT_SCHEMA_VERSION} artifact`,
    });

    const divergent = pinnedState(artifact);
    divergent.functions = divergent.functions.map((entry) => entry.name === "list_changes"
      ? { ...entry, prosrcMd5: "0".repeat(32) }
      : entry);
    expect(decideRealtimeTenantSchema(artifact, divergent)).toEqual({
      mode: "leave",
      reason: "realtime.list_changes is already present, so the existing schema is left alone",
    });

    const missingListChanges = pinnedState(artifact);
    missingListChanges.listChangesPresent = false;
    missingListChanges.functions = missingListChanges.functions.filter((entry) => entry.name !== "list_changes");
    expect(decideRealtimeTenantSchema(artifact, missingListChanges).mode).toBe("install");
  });

  test("installs the schema only when the rust gateway is the server and list_changes is absent", async () => {
    const previous = config.realtimeEngine;
    const artifact = pinnedRealtimeTenantSchemaArtifact();
    const pinned = pinnedState(artifact);
    try {
      config.realtimeEngine = "container";
      const containerCalls: string[] = [];
      expect(await ensureOfficialRealtimeTenantSchema({
        unsafe: async (query) => {
          containerCalls.push(query);
          return [];
        },
      })).toBe(false);
      expect(containerCalls).toEqual([]);

      config.realtimeEngine = "rust";
      const presentCalls: string[] = [];
      expect(await ensureOfficialRealtimeTenantSchema({
        unsafe: async (query) => {
          presentCalls.push(query);
          return [{ state: pinned }];
        },
      })).toBe(false);
      expect(presentCalls).toHaveLength(1);
      expect(presentCalls[0]).toContain("realtime.list_changes(name,name,integer,integer)");

      const divergentCalls: string[] = [];
      const divergent = {
        ...pinned,
        functions: pinned.functions.map((entry) => entry.name === "list_changes"
          ? { ...entry, prosrcMd5: "0".repeat(32) }
          : entry),
      };
      expect(await ensureOfficialRealtimeTenantSchema({
        unsafe: async (query) => {
          divergentCalls.push(query);
          return [{ state: divergent }];
        },
      })).toBe(false);
      expect(divergentCalls).toHaveLength(1);

      const applied: string[] = [];
      expect(await ensureOfficialRealtimeTenantSchema({
        unsafe: async (query) => {
          applied.push(query);
          return [{ state: emptyState() }];
        },
      })).toBe(true);
      expect(applied).toHaveLength(2);
      expect(applied[1]).toContain("function realtime.list_changes");
      expect(applied[1]).not.toMatch(/create schema\s+"realtime"/i);
      expect(applied[1]).not.toMatch(/drop schema/i);
    } finally {
      config.realtimeEngine = previous;
    }
  });
});
