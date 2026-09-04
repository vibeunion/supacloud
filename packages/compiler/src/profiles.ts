import type { ModuleBoundaryPresetName, ModuleBoundaryProfile, ModuleBoundaryRule } from "./types";

/**
 * 模块化单体 / 垂直切片架构规则集：
 * - type:feature 业务垂直切片之间禁止相互依赖（高内聚低耦合），禁止反向依赖 root/app；
 * - type:root / type:app 顶层入口模块仅允许汇聚组装 feature、core、shared、domain 模块；
 * - type:core 底层核心单例/基础设施禁止向上依赖 feature 或 root/app；
 * - type:shared 通用公共工具/组件禁止依赖 feature 或 root/app。
 */
export const MODULAR_MONOLITH_RULES: ModuleBoundaryRule[] = [
  {
    sourceTag: "type:feature",
    bannedDependenciesWithTags: ["type:feature", "type:root", "type:app"],
  },
  {
    sourceTag: "type:root",
    onlyDependOnLibsWithTags: ["type:feature", "type:core", "type:shared", "type:domain"],
  },
  {
    sourceTag: "type:app",
    onlyDependOnLibsWithTags: ["type:feature", "type:core", "type:shared", "type:domain"],
  },
  {
    sourceTag: "type:core",
    bannedDependenciesWithTags: ["type:feature", "type:root", "type:app"],
  },
  {
    sourceTag: "type:shared",
    bannedDependenciesWithTags: ["type:feature", "type:core", "type:root", "type:app"],
  },
];

/**
 * Angular / Nx 企业级 monorepo 架构分层规则集：
 * 遵循 Nx / Angular Enterprise Monorepo 推荐规范：
 * - feature 业务切片禁止互相直接依赖；
 * - ui / data-access / util / shared 库禁止反向上层依赖 feature 或 root；
 * - root / app 仅作为组装入口。
 */
export const ANGULAR_ENTERPRISE_RULES: ModuleBoundaryRule[] = [
  {
    sourceTag: "type:feature",
    bannedDependenciesWithTags: ["type:feature", "type:root", "type:app"],
  },
  {
    sourceTag: "type:ui",
    bannedDependenciesWithTags: ["type:feature", "type:root", "type:app"],
  },
  {
    sourceTag: "type:data-access",
    bannedDependenciesWithTags: ["type:feature", "type:ui", "type:root", "type:app"],
  },
  {
    sourceTag: "type:util",
    bannedDependenciesWithTags: ["type:feature", "type:ui", "type:data-access", "type:root", "type:app"],
  },
  {
    sourceTag: "type:shared",
    bannedDependenciesWithTags: ["type:feature", "type:root", "type:app"],
  },
  {
    sourceTag: "type:core",
    bannedDependenciesWithTags: ["type:feature", "type:root", "type:app"],
  },
  {
    sourceTag: "type:root",
    onlyDependOnLibsWithTags: ["type:feature", "type:ui", "type:data-access", "type:core", "type:shared", "type:util"],
  },
  {
    sourceTag: "type:app",
    onlyDependOnLibsWithTags: ["type:feature", "type:ui", "type:data-access", "type:core", "type:shared", "type:util"],
  },
];

/**
 * Clean Architecture / DDD 经典分层架构规则集（类似 Spring Boot DDD 规范）：
 * - 控制/展现层（api/controller/presentation）仅能依赖应用服务层、领域层与公共层；
 * - 应用服务层（application/service）编排业务用例，仅依赖领域层与公共层；
 * - 领域核心层（domain）保持绝对纯净，禁止依赖任何表现层、应用服务层、基础设施层或根模块；
 * - 基础设施层（infrastructure/infra）依赖倒置，实现领域接口，仅允许依赖领域层与公共层。
 */
export const CLEAN_ARCHITECTURE_RULES: ModuleBoundaryRule[] = [
  {
    sourceTag: "type:api",
    onlyDependOnLibsWithTags: ["type:application", "type:domain", "type:shared", "type:common"],
  },
  {
    sourceTag: "type:controller",
    onlyDependOnLibsWithTags: ["type:application", "type:domain", "type:shared", "type:common"],
  },
  {
    sourceTag: "type:presentation",
    onlyDependOnLibsWithTags: ["type:application", "type:domain", "type:shared", "type:common"],
  },
  {
    sourceTag: "type:application",
    onlyDependOnLibsWithTags: ["type:domain", "type:shared", "type:common"],
  },
  {
    sourceTag: "type:service",
    onlyDependOnLibsWithTags: ["type:domain", "type:shared", "type:common"],
  },
  {
    sourceTag: "type:domain",
    bannedDependenciesWithTags: [
      "type:api",
      "type:controller",
      "type:presentation",
      "type:application",
      "type:service",
      "type:infrastructure",
      "type:infra",
      "type:root",
      "type:app",
    ],
  },
  {
    sourceTag: "type:infrastructure",
    onlyDependOnLibsWithTags: ["type:domain", "type:shared", "type:common"],
  },
  {
    sourceTag: "type:infra",
    onlyDependOnLibsWithTags: ["type:domain", "type:shared", "type:common"],
  },
];

/** 内置支持的模块边界 Profile 注册表。 */
export const MODULE_BOUNDARY_PROFILES: Record<ModuleBoundaryPresetName, ModuleBoundaryProfile> = {
  "modular-monolith": {
    name: "modular-monolith",
    description: "模块化单体 / 垂直业务切片预设（禁止 Feature 交叉依赖，Root 模块仅聚合 Feature/Core/Shared/Domain）",
    rules: MODULAR_MONOLITH_RULES,
  },
  "feature-slices": {
    name: "feature-slices",
    description: "垂直业务切片预设（modular-monolith 别名）",
    rules: MODULAR_MONOLITH_RULES,
  },
  "vertical-slices": {
    name: "vertical-slices",
    description: "垂直切片架构预设（modular-monolith 别名）",
    rules: MODULAR_MONOLITH_RULES,
  },
  "angular-enterprise": {
    name: "angular-enterprise",
    description: "Angular / Nx 企业级 monorepo 预设（约束 Feature、UI、Data-Access、Util、Shared 与 Root 分层流向）",
    rules: ANGULAR_ENTERPRISE_RULES,
  },
  "angular": {
    name: "angular",
    description: "Angular 企业级分层预设（angular-enterprise 别名）",
    rules: ANGULAR_ENTERPRISE_RULES,
  },
  "clean-architecture": {
    name: "clean-architecture",
    description: "Clean Architecture / DDD 分层预设（API/Presentation -> Application -> Domain <- Infrastructure）",
    rules: CLEAN_ARCHITECTURE_RULES,
  },
  "domain-driven": {
    name: "domain-driven",
    description: "DDD 分层架构预设（clean-architecture 别名）",
    rules: CLEAN_ARCHITECTURE_RULES,
  },
};

/**
 * 根据预设名称获取对应的架构治理规则集合。
 */
export function getModuleBoundaryProfile(name: ModuleBoundaryPresetName): ModuleBoundaryProfile {
  const profile = MODULE_BOUNDARY_PROFILES[name];
  if (!profile) {
    throw new Error(
      `未知的模块边界预设 Profile: '${name}'。支持的预设包括: ${Object.keys(MODULE_BOUNDARY_PROFILES).join(", ")}`,
    );
  }
  return {
    ...profile,
    rules: profile.rules.map((rule) => ({
      ...rule,
      onlyDependOnLibsWithTags: rule.onlyDependOnLibsWithTags ? [...rule.onlyDependOnLibsWithTags] : undefined,
      bannedDependenciesWithTags: rule.bannedDependenciesWithTags ? [...rule.bannedDependenciesWithTags] : undefined,
    })),
  };
}

/**
 * 获取指定预设包含的规则列表副本。
 */
export function getModuleBoundaryPreset(name: ModuleBoundaryPresetName): ModuleBoundaryRule[] {
  return getModuleBoundaryProfile(name).rules;
}

/**
 * 解析并合并模块边界规则（支持 preset 预设 + 用户自定义 rules 叠加扩展）。
 */
export function resolveModuleBoundaries(options?: {
  preset?: ModuleBoundaryPresetName;
  rules?: ModuleBoundaryRule[];
}): ModuleBoundaryRule[] | undefined {
  if (!options) return undefined;
  const { preset, rules } = options;
  if (!preset && !rules) return undefined;

  const presetRules = preset ? getModuleBoundaryPreset(preset) : [];
  const customRules = rules ?? [];
  const merged = [...presetRules, ...customRules];
  return merged.length > 0 ? merged : undefined;
}
