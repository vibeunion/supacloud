import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ApplicationGraph, Diagnostic, ModuleNode, ProviderNode } from "./types";

export interface DoctorResult {
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  diagnostics: ApplicationGraph["diagnostics"];
  errors: number;
}

export function formatGraph(graph: ApplicationGraph): string {
  const lines: string[] = [];
  for (const module of graph.modules) {
    lines.push(`MODULE ${module.name}`);
    lines.push(`  file: ${module.file}:${module.line}`);
    lines.push(`  imports: ${module.imports.length > 0 ? module.imports.join(", ") : "-"}`);
    lines.push(`  providers: ${module.providers.length > 0 ? module.providers.map((p) => p.token).join(", ") : "-"}`);
    lines.push(`  controllers: ${module.controllers.length > 0 ? module.controllers.map((c) => c.className).join(", ") : "-"}`);
    lines.push(`  commands: ${module.commands.length > 0 ? module.commands.map((c) => c.name).join(", ") : "-"}`);
  }
  lines.push(`EXTERNAL TOKENS ${graph.externalTokens.length > 0 ? graph.externalTokens.join(", ") : "-"}`);
  return lines.join("\n");
}

export function explainGraph(graph: ApplicationGraph, subject: string): string {
  const module = graph.modules.find((candidate) => candidate.name === subject);
  if (module) return explainModule(graph, module);

  const provider = findProvider(graph, subject);
  if (provider) return explainProvider(graph, provider.module, provider.provider);

  if (graph.externalTokens.includes(subject)) {
    const references = graph.modules.flatMap((candidate) => [
      ...candidate.providers.filter((item) => item.deps.includes(subject)).map((item) => `${candidate.name}.${item.token}`),
      ...candidate.controllers.filter((item) => item.deps.includes(subject)).map((item) => `${candidate.name}.${item.className}`),
    ]);
    return [
      `EXTERNAL TOKEN ${subject}`,
      "  provided by: platform runtime",
      `  references: ${references.length > 0 ? references.join(", ") : "-"}`,
    ].join("\n");
  }

  const known = [...graph.modules.map((item) => item.name), ...graph.externalTokens].sort();
  throw new Error(`No module, provider, or external token named "${subject}". Known names: ${known.join(", ") || "(none)"}`);
}

export function doctorProject(
  rootDir: string,
  outDir: string,
  graph: ApplicationGraph,
  upToDate: boolean,
  diagnostics: Diagnostic[] = [],
): DoctorResult {
  const checks = [
    {
      name: "project-root",
      ok: existsSync(rootDir),
      detail: existsSync(rootDir) ? rootDir : `missing: ${rootDir}`,
    },
    {
      name: "tsconfig",
      ok: existsSync(join(rootDir, "tsconfig.json")),
      detail: existsSync(join(rootDir, "tsconfig.json")) ? "tsconfig.json found" : "tsconfig.json missing",
    },
    {
      name: "modules",
      ok: graph.modules.length > 0,
      detail: `${graph.modules.length} module(s) discovered`,
    },
    {
      name: "generated-artifacts",
      ok: upToDate,
      detail: upToDate ? "application.ts and app.manifest.json are up to date" : "generated artifacts are missing or stale",
    },
  ];
  const allDiagnostics = [...(graph.diagnostics ?? []), ...diagnostics];
  return {
    checks,
    diagnostics: allDiagnostics,
    errors: allDiagnostics.filter((diagnostic) => diagnostic.severity === "error").length + checks.filter((check) => !check.ok).length,
  };
}

function explainModule(graph: ApplicationGraph, module: ModuleNode): string {
  const dependents = graph.modules.filter((candidate) => candidate.imports.includes(module.name)).map((candidate) => candidate.name);
  return [
    `MODULE ${module.name}`,
    `  file: ${module.file}:${module.line}`,
    `  imports: ${module.imports.length > 0 ? module.imports.join(", ") : "-"}`,
    `  imported by: ${dependents.length > 0 ? dependents.join(", ") : "-"}`,
    `  providers: ${module.providers.length > 0 ? module.providers.map((provider) => provider.token).join(", ") : "-"}`,
    `  controllers: ${module.controllers.length > 0 ? module.controllers.map((controller) => controller.className).join(", ") : "-"}`,
    `  commands: ${module.commands.length > 0 ? module.commands.map((command) => command.name).join(", ") : "-"}`,
  ].join("\n");
}

function explainProvider(graph: ApplicationGraph, module: ModuleNode, provider: ProviderNode): string {
  const dependents = graph.modules.flatMap((candidate) => [
    ...candidate.providers.filter((item) => item.deps.includes(provider.token)).map((item) => `${candidate.name}.${item.token}`),
    ...candidate.controllers.filter((item) => item.deps.includes(provider.token)).map((item) => `${candidate.name}.${item.className}`),
  ]);
  return [
    `PROVIDER ${provider.token}`,
    `  module: ${module.name}`,
    `  file: ${provider.file}:${provider.line}`,
    `  kind: ${provider.kind}`,
    `  scope: ${provider.scope}`,
    `  exported: ${provider.exported ? "yes" : "no"}`,
    `  deps: ${provider.deps.length > 0 ? provider.deps.join(", ") : "-"}`,
    `  depended on by: ${dependents.length > 0 ? dependents.join(", ") : "-"}`,
  ].join("\n");
}

function findProvider(graph: ApplicationGraph, subject: string): { module: ModuleNode; provider: ProviderNode } | undefined {
  for (const module of graph.modules) {
    const provider = module.providers.find((candidate) => candidate.token === subject || candidate.useClass === subject || candidate.useFactoryName === subject);
    if (provider) return { module, provider };
  }
  return undefined;
}
