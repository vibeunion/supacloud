import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../src/config";
import {
  OFFICIAL_REALTIME_APPLY_RLS_SHA256,
  OFFICIAL_REALTIME_LIST_CHANGES_SHA256,
  OFFICIAL_REALTIME_TENANT_SCHEMA_FILES,
  ensureOfficialRealtimeTenantSchema,
  officialRealtimeTenantSchemaSql,
  sha256Text,
} from "../../src/db/realtime-tenant-schema";

const schemaDir = join(import.meta.dir, "../../src/db/realtime-tenant-schema");

describe("official realtime tenant schema", () => {
  test("ships the pinned list_changes and apply_rls bytes", () => {
    const files = new Map(OFFICIAL_REALTIME_TENANT_SCHEMA_FILES);
    const order = readFileSync(join(schemaDir, "order.txt"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect([...files.keys()]).toEqual(order);
    expect(sha256Text(files.get("realtime/functions/apply_rls.sql") ?? "")).toBe(
      OFFICIAL_REALTIME_APPLY_RLS_SHA256,
    );
    expect(sha256Text(files.get("realtime/functions/list_changes.sql") ?? "")).toBe(
      OFFICIAL_REALTIME_LIST_CHANGES_SHA256,
    );
  });

  test("does not create the realtime schema that supabase.sql already owns", () => {
    const sql = officialRealtimeTenantSchemaSql();
    expect(sql).not.toMatch(/create schema\s+"realtime"/i);
    expect(sql).toContain('grant usage on schema "realtime"');
    expect(sql).toContain("function realtime.list_changes");
    expect(sql).toContain("function realtime.apply_rls");
    expect(sql).toContain('create table "realtime"."subscription"');
  });

  test("installs the schema only when the rust gateway is the server and the function is missing", async () => {
    const previous = config.realtimeEngine;
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
          return [{ present: true }];
        },
      })).toBe(false);
      expect(presentCalls).toHaveLength(1);
      expect(presentCalls[0]).toContain("realtime.list_changes(name,name,integer,integer)");

      const applied: string[] = [];
      expect(await ensureOfficialRealtimeTenantSchema({
        unsafe: async (query) => {
          applied.push(query);
          return [{ present: false }];
        },
      })).toBe(true);
      expect(applied).toHaveLength(2);
      expect(applied[1]).toContain("function realtime.list_changes");
      expect(applied[1]).not.toMatch(/create schema\s+"realtime"/i);
    } finally {
      config.realtimeEngine = previous;
    }
  });
});
