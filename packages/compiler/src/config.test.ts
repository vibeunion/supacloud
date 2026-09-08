import { describe, expect, test } from "bun:test";
import {
  compileOptionsFromConfig,
  defineSupacloudConfig,
  resolveSupacloudConfig,
} from "./config";

describe("SupaCloud default configuration", () => {
  test("provides a strict zero-config project baseline", () => {
    expect(defineSupacloudConfig()).toMatchObject({
      root: "src",
      outDir: "generated",
      strict: true,
      generateClient: true,
      generatePermissions: true,
      treeShakeUnusedProviders: true,
      moduleBoundaryPreset: "modular-monolith",
      graphql: false,
    });
  });

  test("existing projects remain optional while configured query contracts are preserved", () => {
    expect(compileOptionsFromConfig({}, "/workspace").graphql).toBeUndefined();
    expect(compileOptionsFromConfig({
      graphql: { schema: "graphql/schema.graphql" },
    }, "/workspace").graphql).toEqual({
      schema: "/workspace/graphql/schema.graphql",
    });
    expect(compileOptionsFromConfig({ graphql: false }, "/workspace").graphql).toBeUndefined();
  });

  test("allows explicit values to override safe defaults", () => {
    expect(resolveSupacloudConfig({
      root: "app",
      outDir: "dist/app",
      strict: false,
      generateClient: false,
      moduleBoundaryPreset: "clean-architecture",
    }, "/workspace")).toMatchObject({
      rootDir: "/workspace/app",
      outDir: "/workspace/dist/app",
      strict: false,
      generateClient: false,
      generatePermissions: true,
      moduleBoundaryPreset: "clean-architecture",
    });
  });

  test("passes command execution capabilities to compiler validation", () => {
    const config = defineSupacloudConfig({
      commandCapabilities: {
        permission: true,
        audit: false,
        idempotency: false,
        transaction: "rpc-only",
      },
    });

    expect(compileOptionsFromConfig(config, "/workspace/app").commandCapabilities).toEqual({
      permission: true,
      audit: false,
      idempotency: false,
      transaction: "rpc-only",
    });
  });
});
