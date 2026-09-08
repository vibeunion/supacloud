export { analyzeProject } from "./analyze";
export { generateFeatureSource, validateFeatureSpec } from "./feature";
export { applyDiagnosticFix } from "./fixes";
export type { AppliedDiagnosticFix, ApplyDiagnosticFixOptions } from "./fixes";
export { checkProject, compileProject } from "./compile";
export { watchProject } from "./watch";
export {
  createContextPack,
  createExecutionPlans,
  doctorProject,
  explainGraph,
  formatGraph,
  exportGraphDot,
  exportGraphMermaid,
} from "./inspect";
export { createIncrementalCompiler } from "./incremental";
export { createDependencyGraphCache } from "./incremental";
export { ModuleDependencyGraph } from "./incremental";
export { createIncrementalProgramSession } from "./program";
export type { IncrementalProgramSession, ProgramUpdate } from "./program";
export { compileTraits } from "./traits";
export { TraitCompiler } from "./traits";
export type { TraitCompilation, TraitHandler, TraitKind, TraitRecord } from "./traits";
export { generateApplication, renderApplication } from "./generate";
export type { GenerateOptions, RenderedArtifacts } from "./generate";
export type { ContextPack, DoctorResult, ExecutionPlan } from "./inspect";
export { validateGraph, COMPILER_DIAGNOSTIC_CODES } from "./validate";
export { scanGeneratedArtifacts, scanProductionSource } from "./type-safety";
export type { TypeSafetyScanOptions } from "./type-safety";
export {
  DEFAULT_SUPACLOUD_CONFIG,
  compileOptionsFromConfig,
  defineSupacloudConfig,
  loadSupacloudConfig,
  resolveSupacloudConfig,
} from "./config";
export type { SupaCloudConfig } from "./config";
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
  AspectRefNode,
  CachedModuleEntry,
  CheckProjectResult,
  CommandExecutionCapabilities,
  CommandNode,
  CompileOptions,
  CompileResult,
  CompileStats,
  ControllerNode,
  DependencyGraphCache,
  DependencyGraphIndex,
  Diagnostic,
  DiagnosticFix,
  ModuleBoundaryPresetName,
  ModuleBoundaryProfile,
  ModuleBoundaryRule,
  ModuleNode,
  JobNode,
  ProviderKind,
  ProviderNode,
  QueryNode,
  RouteNode,
  Scope,
  TokenKind,
  TypeSafetyOptions,
  ValidateOptions,
  WatchEvent,
  WatchHandle,
  WatchOptions,
  FeatureSpecNode,
  FeatureTransitionNode,
} from "./types";
export { inspectRouteContracts, validateRouteContracts } from "./route-contracts";
