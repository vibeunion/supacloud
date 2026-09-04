import { describe, expect, test } from "bun:test";
import {
  ANGULAR_ENTERPRISE_RULES,
  CLEAN_ARCHITECTURE_RULES,
  MODULAR_MONOLITH_RULES,
  MODULE_BOUNDARY_PROFILES,
  getModuleBoundaryPreset,
  getModuleBoundaryProfile,
  resolveModuleBoundaries,
} from "./profiles";
import type { ModuleBoundaryRule } from "./types";

describe("Architecture governance presets (profiles.ts)", () => {
  test("includes the built-in presets and their aliases", () => {
    const presetNames = Object.keys(MODULE_BOUNDARY_PROFILES);
    expect(presetNames).toContain("modular-monolith");
    expect(presetNames).toContain("feature-slices");
    expect(presetNames).toContain("vertical-slices");
    expect(presetNames).toContain("angular-enterprise");
    expect(presetNames).toContain("angular");
    expect(presetNames).toContain("clean-architecture");
    expect(presetNames).toContain("domain-driven");
  });

  test("getModuleBoundaryProfile returns metadata and defensive rule copies", () => {
    const profile = getModuleBoundaryProfile("modular-monolith");
    expect(profile.name).toBe("modular-monolith");
    expect(profile.description).toContain("Modular monolith");
    expect(profile.rules.length).toBeGreaterThan(0);

    // Mutating the returned array must not affect the original preset definition.
    const originalLength = profile.rules.length;
    profile.rules.push({ sourceTag: "test" });
    const reloaded = getModuleBoundaryProfile("modular-monolith");
    expect(reloaded.rules.length).toBe(originalLength);
  });

  test("getModuleBoundaryPreset returns a defensive rule copy", () => {
    const rules = getModuleBoundaryPreset("angular-enterprise");
    expect(rules).toEqual(ANGULAR_ENTERPRISE_RULES);
    expect(rules).not.toBe(ANGULAR_ENTERPRISE_RULES); // Independent reference.
  });

  test("getModuleBoundaryProfile rejects unknown presets with a useful error", () => {
    expect(() => getModuleBoundaryProfile("unknown-preset" as any)).toThrow(
      "Unknown module boundary preset: 'unknown-preset'",
    );
  });

  test("resolveModuleBoundaries returns undefined without options", () => {
    expect(resolveModuleBoundaries()).toBeUndefined();
    expect(resolveModuleBoundaries({})).toBeUndefined();
  });

  test("resolveModuleBoundaries loads built-in rules for a preset", () => {
    const resolved = resolveModuleBoundaries({ preset: "modular-monolith" });
    expect(resolved).toEqual(MODULAR_MONOLITH_RULES);
  });

  test("resolveModuleBoundaries preserves custom rules without a preset", () => {
    const custom: ModuleBoundaryRule[] = [{ sourceTag: "custom", bannedDependenciesWithTags: ["bad"] }];
    const resolved = resolveModuleBoundaries({ rules: custom });
    expect(resolved).toEqual(custom);
  });

  test("resolveModuleBoundaries appends custom rules after preset rules", () => {
    const custom: ModuleBoundaryRule[] = [{ sourceTag: "custom", bannedDependenciesWithTags: ["bad"] }];
    const resolved = resolveModuleBoundaries({ preset: "domain-driven", rules: custom });
    expect(resolved).toBeDefined();
    expect(resolved!.length).toBe(CLEAN_ARCHITECTURE_RULES.length + 1);
    expect(resolved![resolved!.length - 1]).toEqual(custom[0]);
  });
});
