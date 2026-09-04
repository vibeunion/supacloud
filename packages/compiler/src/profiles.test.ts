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

describe("架构治理预设 Profile (profiles.ts)", () => {
  test("内置预设完整性：覆盖 modular-monolith / angular-enterprise / clean-architecture 及常用别名", () => {
    const presetNames = Object.keys(MODULE_BOUNDARY_PROFILES);
    expect(presetNames).toContain("modular-monolith");
    expect(presetNames).toContain("feature-slices");
    expect(presetNames).toContain("vertical-slices");
    expect(presetNames).toContain("angular-enterprise");
    expect(presetNames).toContain("angular");
    expect(presetNames).toContain("clean-architecture");
    expect(presetNames).toContain("domain-driven");
  });

  test("getModuleBoundaryProfile：获取预设元数据与规则副本（防外部篡改）", () => {
    const profile = getModuleBoundaryProfile("modular-monolith");
    expect(profile.name).toBe("modular-monolith");
    expect(profile.description).toContain("模块化单体");
    expect(profile.rules.length).toBeGreaterThan(0);

    // 修改返回数组不影响预设原始定义
    const originalLength = profile.rules.length;
    profile.rules.push({ sourceTag: "test" });
    const reloaded = getModuleBoundaryProfile("modular-monolith");
    expect(reloaded.rules.length).toBe(originalLength);
  });

  test("getModuleBoundaryPreset：直接获取规则列表副本", () => {
    const rules = getModuleBoundaryPreset("angular-enterprise");
    expect(rules).toEqual(ANGULAR_ENTERPRISE_RULES);
    expect(rules).not.toBe(ANGULAR_ENTERPRISE_RULES); // 独立引用
  });

  test("getModuleBoundaryProfile：未知预设抛出友好异常提示", () => {
    expect(() => getModuleBoundaryProfile("unknown-preset" as any)).toThrow(
      "未知的模块边界预设 Profile: 'unknown-preset'",
    );
  });

  test("resolveModuleBoundaries：无入参返回 undefined", () => {
    expect(resolveModuleBoundaries()).toBeUndefined();
    expect(resolveModuleBoundaries({})).toBeUndefined();
  });

  test("resolveModuleBoundaries：仅指定 preset 时加载内置规则", () => {
    const resolved = resolveModuleBoundaries({ preset: "modular-monolith" });
    expect(resolved).toEqual(MODULAR_MONOLITH_RULES);
  });

  test("resolveModuleBoundaries：仅指定 custom rules 时保留自定义规则", () => {
    const custom: ModuleBoundaryRule[] = [{ sourceTag: "custom", bannedDependenciesWithTags: ["bad"] }];
    const resolved = resolveModuleBoundaries({ rules: custom });
    expect(resolved).toEqual(custom);
  });

  test("resolveModuleBoundaries：叠加 preset 与 custom rules（preset 在前，custom 在后）", () => {
    const custom: ModuleBoundaryRule[] = [{ sourceTag: "custom", bannedDependenciesWithTags: ["bad"] }];
    const resolved = resolveModuleBoundaries({ preset: "domain-driven", rules: custom });
    expect(resolved).toBeDefined();
    expect(resolved!.length).toBe(CLEAN_ARCHITECTURE_RULES.length + 1);
    expect(resolved![resolved!.length - 1]).toEqual(custom[0]);
  });
});
