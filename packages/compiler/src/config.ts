import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  CommandExecutionCapabilities,
  CompileOptions,
  ModuleBoundaryPresetName,
} from "./types";

export interface SupaCloudConfig {
  root?: string;
  outDir?: string;
  include?: string[];
  strict?: boolean;
  requireRouteContracts?: boolean;
  generateClient?: boolean;
  generatePermissions?: boolean;
  moduleBoundaryPreset?: ModuleBoundaryPresetName;
  commandCapabilities?: CommandExecutionCapabilities;
  treeShakeUnusedProviders?: boolean;
}

export const DEFAULT_SUPACLOUD_CONFIG: Required<Omit<
  SupaCloudConfig,
  "include" | "moduleBoundaryPreset" | "commandCapabilities"
>> & {
  include: string[];
  moduleBoundaryPreset: ModuleBoundaryPresetName;
} = {
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
  return {
    ...DEFAULT_SUPACLOUD_CONFIG,
    ...config,
    include: config.include ?? [...DEFAULT_SUPACLOUD_CONFIG.include],
  };
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
  treeShakeUnusedProviders: boolean;
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
    treeShakeUnusedProviders: resolved.treeShakeUnusedProviders ?? DEFAULT_SUPACLOUD_CONFIG.treeShakeUnusedProviders,
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
  const resolved = resolveSupacloudConfig(config, cwd);
  return {
    rootDir: resolved.rootDir,
    outDir: resolved.outDir,
    include: resolved.include,
    strict: resolved.strict,
    requireRouteContracts: resolved.requireRouteContracts,
    generateClient: resolved.generateClient,
    generatePermissions: resolved.generatePermissions,
    moduleBoundaryPreset: resolved.moduleBoundaryPreset,
    commandCapabilities: resolved.commandCapabilities,
    treeShakeUnusedProviders: resolved.treeShakeUnusedProviders,
  };
}
