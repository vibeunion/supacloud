import type { ModuleBoundaryPresetName, ModuleBoundaryProfile, ModuleBoundaryRule } from "./types";

/**
 * Modular monolith / vertical slice architecture rules:
 * - type:feature slices cannot depend on one another or on root/app modules;
 * - type:root / type:app entry modules may aggregate feature, core, shared, and domain modules;
 * - type:core foundational modules cannot depend upward on feature or root/app modules;
 * - type:shared common utilities/components cannot depend on feature or root/app modules.
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
 * Angular / Nx enterprise monorepo layering rules:
 * follows the recommended Nx / Angular enterprise workspace conventions:
 * - feature slices cannot directly depend on one another;
 * - ui / data-access / util / shared libraries cannot depend upward on feature or root modules;
 * - root / app modules serve only as composition entry points.
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
 * Clean Architecture / DDD layering rules (similar to Spring Boot DDD conventions):
 * - presentation layers (api/controller/presentation) may depend only on application, domain, and shared layers;
 * - application layers (application/service) orchestrate use cases and depend only on domain and shared layers;
 * - the domain layer remains pure and cannot depend on presentation, application, infrastructure, or root modules;
 * - infrastructure layers (infrastructure/infra) implement domain ports and may depend only on domain and shared layers.
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

/** Registry of built-in module boundary profiles. */
export const MODULE_BOUNDARY_PROFILES: Record<ModuleBoundaryPresetName, ModuleBoundaryProfile> = {
  "modular-monolith": {
    name: "modular-monolith",
    description: "Modular monolith / vertical slice preset (blocks cross-feature dependencies and limits root aggregation to feature/core/shared/domain)",
    rules: MODULAR_MONOLITH_RULES,
  },
  "feature-slices": {
    name: "feature-slices",
    description: "Vertical slice preset (alias for modular-monolith)",
    rules: MODULAR_MONOLITH_RULES,
  },
  "vertical-slices": {
    name: "vertical-slices",
    description: "Vertical slice architecture preset (alias for modular-monolith)",
    rules: MODULAR_MONOLITH_RULES,
  },
  "angular-enterprise": {
    name: "angular-enterprise",
    description: "Angular / Nx enterprise monorepo preset (enforces one-way layering across feature, UI, data-access, util, shared, and root modules)",
    rules: ANGULAR_ENTERPRISE_RULES,
  },
  "angular": {
    name: "angular",
    description: "Angular enterprise layering preset (alias for angular-enterprise)",
    rules: ANGULAR_ENTERPRISE_RULES,
  },
  "clean-architecture": {
    name: "clean-architecture",
    description: "Clean Architecture / DDD layering preset (API/presentation -> application -> domain <- infrastructure)",
    rules: CLEAN_ARCHITECTURE_RULES,
  },
  "domain-driven": {
    name: "domain-driven",
    description: "DDD layering preset (alias for clean-architecture)",
    rules: CLEAN_ARCHITECTURE_RULES,
  },
};

/** Return the architecture governance rules for a preset name. */
export function getModuleBoundaryProfile(name: ModuleBoundaryPresetName): ModuleBoundaryProfile {
  const profile = MODULE_BOUNDARY_PROFILES[name];
  if (!profile) {
    throw new Error(
      `Unknown module boundary preset: '${name}'. Supported presets: ${Object.keys(MODULE_BOUNDARY_PROFILES).join(", ")}`,
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

/** Return a copy of the rules included in a preset. */
export function getModuleBoundaryPreset(name: ModuleBoundaryPresetName): ModuleBoundaryRule[] {
  return getModuleBoundaryProfile(name).rules;
}

/** Resolve and merge preset rules with optional user-defined rules. */
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
