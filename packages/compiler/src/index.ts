export { analyzeProject } from "./analyze";
export { checkProject, compileProject } from "./compile";
export { watchProject } from "./watch";
export { doctorProject, explainGraph, formatGraph } from "./inspect";
export { createIncrementalCompiler } from "./incremental";
export { createDependencyGraphCache } from "./incremental";
export { generateApplication, renderApplication } from "./generate";
export type { GenerateOptions, RenderedArtifacts } from "./generate";
export type { DoctorResult } from "./inspect";
export { validateGraph, COMPILER_DIAGNOSTIC_CODES } from "./validate";
export { camelName } from "./util";
export {
  ANGULAR_ENTERPRISE_RULES,
  CLEAN_ARCHITECTURE_RULES,
  MODULAR_MONOLITH_RULES,
  MODULE_BOUNDARY_PROFILES,
  getModuleBoundaryPreset,
  getModuleBoundaryProfile,
  resolveModuleBoundaries,
} from "./profiles";
export type {
  ApplicationGraph,
  CachedModuleEntry,
  CheckProjectResult,
  CommandExecutionCapabilities,
  CommandNode,
  CompileOptions,
  CompileResult,
  CompileStats,
  ControllerNode,
  DependencyGraphCache,
  Diagnostic,
  ModuleBoundaryPresetName,
  ModuleBoundaryProfile,
  ModuleBoundaryRule,
  ModuleNode,
  ProviderKind,
  ProviderNode,
  QueryNode,
  RouteNode,
  Scope,
  TokenKind,
  ValidateOptions,
  WatchEvent,
  WatchHandle,
  WatchOptions,
} from "./types";
