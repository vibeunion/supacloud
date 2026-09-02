import { analyzeProject } from "./analyze";
import { generateApplication } from "./generate";
import type { CompileOptions, CompileResult, Diagnostic } from "./types";
import { validateGraph } from "./validate";

/**
 * 完整编译流程：AST 分析 → 校验 → 生成静态工厂代码与 manifest。
 * 即使存在 error 级诊断也会照常写出文件，由调用方根据 diagnostics 决定是否采用。
 */
export async function compileProject(options: CompileOptions): Promise<CompileResult> {
  const graph = await analyzeProject(options.rootDir, options.include);
  const diagnostics: Diagnostic[] = [
    ...(graph.diagnostics ?? []),
    ...validateGraph(graph, options.strict),
  ];
  if (options.strict) {
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity === "warn") diagnostic.severity = "error";
    }
  }
  const written = await generateApplication(graph, {
    rootDir: options.rootDir,
    outDir: options.outDir,
  });
  return { diagnostics, graph, written };
}
