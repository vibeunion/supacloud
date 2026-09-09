import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertGraphqlOptions } from "./graphql-options";
import type {
  CommandExecutionCapabilities,
  CompileOptions,
  GraphqlOptions,
  ModuleBoundaryPresetName,
} from "./types";

export interface SupaCloudConfig {
  /** Opt-in outside app init. Schema is configuration-relative; documents are root-relative. */
  graphql?: GraphqlOptions | false;
  root?: string;
  outDir?: string;
  include?: string[];
  strict?: boolean;
  requireRouteContracts?: boolean;
  generateClient?: boolean;
  generatePermissions?: boolean;
  moduleBoundaryPreset?: ModuleBoundaryPresetName;
  moduleBoundaries?: NonNullable<CompileOptions["moduleBoundaries"]>;
  typeSafety?: NonNullable<CompileOptions["typeSafety"]>;
  allowRouteCommandBindings?: boolean;
  disallowControllerDirectDb?: boolean;
  detectOrphanModules?: boolean;
  commandCapabilities?: CommandExecutionCapabilities;
  treeShakeUnusedProviders?: boolean;
}

export const DEFAULT_SUPACLOUD_CONFIG: Required<Omit<
  SupaCloudConfig,
  "include" | "moduleBoundaryPreset" | "commandCapabilities" | "moduleBoundaries" | "typeSafety"
  | "allowRouteCommandBindings" | "disallowControllerDirectDb" | "detectOrphanModules"
>> & {
  include: string[];
  moduleBoundaryPreset: ModuleBoundaryPresetName;
} = {
  graphql: false,
  root: "src",
  outDir: "generated",
  include: ["**/*.module.ts", "**/*.ts"],
  strict: true,
  requireRouteContracts: false,
  generateClient: true,
  generatePermissions: true,
  treeShakeUnusedProviders: true,
  moduleBoundaryPreset: "modular-monolith",
};

export function defineSupacloudConfig(config: SupaCloudConfig = {}): SupaCloudConfig {
  if (config.graphql !== undefined && config.graphql !== false) assertGraphqlOptions(config.graphql);
  validateGovernanceConfig(config);
  return {
    ...DEFAULT_SUPACLOUD_CONFIG,
    ...config,
    include: config.include ?? [...DEFAULT_SUPACLOUD_CONFIG.include],
    graphql: config.graphql ?? DEFAULT_SUPACLOUD_CONFIG.graphql,
  };
}

/** Configuration modules are executable inputs; reject invalid new rule options before compiling. */
function validateGovernanceConfig(config: {
  commandCapabilities?: unknown;
  moduleBoundaries?: unknown;
  typeSafety?: unknown;
  allowRouteCommandBindings?: unknown;
  disallowControllerDirectDb?: unknown;
  detectOrphanModules?: unknown;
}): void {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const isStrings = (value: unknown): value is string[] =>
    Array.isArray(value) && Array.from(value).every((item: unknown) => typeof item === "string" && item.trim().length > 0);
  if (config.commandCapabilities !== undefined) {
    const capabilities = config.commandCapabilities;
    if (!isRecord(capabilities) || Object.keys(capabilities).some((key) =>
      !["permission", "audit", "idempotency", "transaction", "rpc", "requirePersistentAdapters"].includes(key))) {
      throw new Error("Invalid commandCapabilities.");
    }
    for (const key of ["permission", "audit", "idempotency", "requirePersistentAdapters"]) {
      if (capabilities[key] !== undefined && typeof capabilities[key] !== "boolean") throw new Error(`commandCapabilities.${key} must be boolean.`);
    }
    if (capabilities["transaction"] !== undefined && typeof capabilities["transaction"] !== "boolean"
      && capabilities["transaction"] !== "rpc-only") throw new Error("Invalid transaction capability.");
    const adapters = capabilities["rpc"];
    if (adapters !== undefined) {
      if (!isRecord(adapters)) throw new Error("commandCapabilities.rpc must contain named adapters.");
      for (const [name, adapter] of Object.entries(adapters)) {
        if (!name.trim() || !isRecord(adapter) || Object.keys(adapter).some((key) =>
          !["audit", "idempotency", "transaction", "boundary"].includes(key))) throw new Error("Invalid command adapter.");
        for (const key of ["audit", "idempotency", "transaction"]) {
          if (adapter[key] !== undefined && typeof adapter[key] !== "boolean") throw new Error("Invalid command adapter capability.");
        }
        if (adapter["boundary"] !== undefined && adapter["boundary"] !== "database" && adapter["boundary"] !== "external") {
          throw new Error("Invalid command adapter boundary.");
        }
        if (adapter["boundary"] === "external" && adapter["transaction"] === true) {
          throw new Error("External command adapters cannot claim database transactions.");
        }
      }
    }
  }
  if (config.moduleBoundaries !== undefined) {
    if (!Array.isArray(config.moduleBoundaries)) throw new Error("moduleBoundaries must be an array of module tag rules.");
    const rules: readonly unknown[] = config.moduleBoundaries;
    for (const rule of rules) {
      if (!isRecord(rule) || typeof rule["sourceTag"] !== "string" || !rule["sourceTag"].trim()
        || Object.keys(rule).some((key) => !["sourceTag", "onlyDependOnLibsWithTags", "bannedDependenciesWithTags"].includes(key))
        || (rule["onlyDependOnLibsWithTags"] !== undefined && !isStrings(rule["onlyDependOnLibsWithTags"]))
        || (rule["bannedDependenciesWithTags"] !== undefined && !isStrings(rule["bannedDependenciesWithTags"]))) {
        throw new Error("moduleBoundaries rules require sourceTag and optional string arrays onlyDependOnLibsWithTags/bannedDependenciesWithTags.");
      }
    }
  }
  if (config.typeSafety !== undefined) {
    const rules = config.typeSafety;
    if (!isRecord(rules)
      || Object.keys(rules).some((key) => !["scanProductionSource", "noAnyInGenerated", "exclude"].includes(key))
      || (rules["scanProductionSource"] !== undefined && typeof rules["scanProductionSource"] !== "boolean")
      || (rules["noAnyInGenerated"] !== undefined && typeof rules["noAnyInGenerated"] !== "boolean")
      || (rules["exclude"] !== undefined && !isStrings(rules["exclude"]))) {
      throw new Error("typeSafety accepts boolean scanProductionSource/noAnyInGenerated and a string array exclude.");
    }
  }
  for (const key of ["allowRouteCommandBindings", "disallowControllerDirectDb", "detectOrphanModules"] as const) {
    if (config[key] !== undefined && typeof config[key] !== "boolean") throw new Error(`${key} must be a boolean.`);
  }
}

export function resolveSupacloudConfig(
  config: SupaCloudConfig = {},
  cwd = process.cwd(),
): {
  rootDir: string;
  outDir: string;
  include: string[];
  strict: boolean;
  requireRouteContracts: boolean;
  generateClient: boolean;
  generatePermissions: boolean;
  moduleBoundaryPreset: ModuleBoundaryPresetName;
  commandCapabilities?: CommandExecutionCapabilities;
  moduleBoundaries?: NonNullable<CompileOptions["moduleBoundaries"]>;
  typeSafety?: NonNullable<CompileOptions["typeSafety"]>;
  allowRouteCommandBindings?: boolean;
  disallowControllerDirectDb?: boolean;
  detectOrphanModules?: boolean;
  treeShakeUnusedProviders: boolean;
  graphql?: GraphqlOptions;
} {
  const resolved = defineSupacloudConfig(config);
  return {
    rootDir: resolve(cwd, resolved.root ?? DEFAULT_SUPACLOUD_CONFIG.root),
    outDir: resolve(cwd, resolved.outDir ?? DEFAULT_SUPACLOUD_CONFIG.outDir),
    include: resolved.include ?? [...DEFAULT_SUPACLOUD_CONFIG.include],
    strict: resolved.strict ?? DEFAULT_SUPACLOUD_CONFIG.strict,
    requireRouteContracts: resolved.requireRouteContracts ?? DEFAULT_SUPACLOUD_CONFIG.requireRouteContracts,
    generateClient: resolved.generateClient ?? DEFAULT_SUPACLOUD_CONFIG.generateClient,
    generatePermissions: resolved.generatePermissions ?? DEFAULT_SUPACLOUD_CONFIG.generatePermissions,
    moduleBoundaryPreset: resolved.moduleBoundaryPreset ?? DEFAULT_SUPACLOUD_CONFIG.moduleBoundaryPreset,
    commandCapabilities: resolved.commandCapabilities,
    ...(resolved.moduleBoundaries ? { moduleBoundaries: resolved.moduleBoundaries } : {}),
    ...(resolved.typeSafety ? { typeSafety: resolved.typeSafety } : {}),
    ...(resolved.allowRouteCommandBindings === undefined ? {} : { allowRouteCommandBindings: resolved.allowRouteCommandBindings }),
    ...(resolved.disallowControllerDirectDb === undefined ? {} : { disallowControllerDirectDb: resolved.disallowControllerDirectDb }),
    ...(resolved.detectOrphanModules === undefined ? {} : { detectOrphanModules: resolved.detectOrphanModules }),
    treeShakeUnusedProviders: resolved.treeShakeUnusedProviders ?? DEFAULT_SUPACLOUD_CONFIG.treeShakeUnusedProviders,
    graphql: resolved.graphql ? {
      ...resolved.graphql,
      schema: resolve(cwd, resolved.graphql.schema),
    } : undefined,
  };
}

export async function loadSupacloudConfig(cwd = process.cwd()): Promise<SupaCloudConfig> {
  const candidates = [
    join(cwd, "supacloud.config.ts"),
    join(cwd, "supacloud.config.mts"),
    join(cwd, "supacloud.config.js"),
    join(cwd, "supacloud.config.mjs"),
  ];
  const configPath = candidates.find((candidate) => existsSync(candidate));
  if (!configPath) return defineSupacloudConfig();
  const imported = await import(pathToFileURL(configPath).href) as {
    default?: SupaCloudConfig;
  };
  return defineSupacloudConfig(imported.default ?? {});
}

export function compileOptionsFromConfig(
  config: SupaCloudConfig,
  cwd = process.cwd(),
): CompileOptions {
  return resolveSupacloudConfig(config, cwd);
}
