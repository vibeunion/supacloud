import { describe, expect, test } from "bun:test";
import { extensionCapability } from "../../src/services/extension-capabilities";

describe("extension capability contracts", () => {
  test("describes stateful queue prerequisites and rollback", () => {
    expect(extensionCapability("pgmq")).toMatchObject({
      lifecycle: "stateful",
      migration: "reviewed_migration",
      backup: "extension_state",
      rollback: "reviewed_migration",
      resources: ["queue_storage", "consumer_concurrency", "visibility_timeout"],
    });
  });

  test("describes vector search as application-owned data with bounded resources", () => {
    expect(extensionCapability("vector")).toMatchObject({
      lifecycle: "safe_toggle",
      backup: "application_data",
      rls: "application_owned",
      resources: ["vector_index_memory", "embedding_dimension"],
    });
  });

  test("marks Vault and pgsodium as administrator-provisioned", () => {
    expect(extensionCapability("supabase_vault").preload).toEqual(["supabase_vault", "pgsodium"]);
    expect(extensionCapability("pgsodium").support).toBe("deprecated");
  });

  test("returns an isolated review contract for unknown extensions", () => {
    const first = extensionCapability("future_extension");
    first.resources.push("caller_mutation");
    expect(extensionCapability("future_extension").resources).toEqual([]);
    expect(first.support).toBe("unclassified");
  });
});
