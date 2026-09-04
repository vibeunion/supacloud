#!/usr/bin/env node
import { resolve } from "node:path";
import { checkProject, compileProject } from "./compile";
import type { ModuleBoundaryPresetName } from "./types";

function printUsage(): void {
  console.log(`
@supacloud/compiler CLI

用法:
  supacloud-compiler compile [rootDir] [选项]
  supacloud-compiler check   [rootDir] [选项]

子命令:
  compile             编译应用模块，生成静态工厂与 manifest 产物
  check               校验产物是否漂移，并执行架构与契约门禁

选项:
  --root, -r <dir>    应用源码根目录（默认当前目录或第一个位置参数）
  --out, -o <dir>     产物输出目录（默认 <rootDir>/generated）
  --strict            开启严格模式，所有警告均视为错误
  --preset, -p <name> 架构治理预设 Profile ('modular-monolith' | 'angular-enterprise' | 'clean-architecture')
  --help, -h          显示帮助信息
`);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const command = args[0];
  if (command !== "compile" && command !== "check") {
    console.error(`错误：未知子命令 "${command}"`);
    printUsage();
    process.exit(1);
  }

  let rootDir = ".";
  let outDir: string | undefined;
  let strict = false;
  let preset: ModuleBoundaryPresetName | undefined;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--root" || arg === "-r") {
      rootDir = args[++i];
    } else if (arg === "--out" || arg === "-o") {
      outDir = args[++i];
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--preset" || arg === "-p") {
      preset = args[++i] as ModuleBoundaryPresetName;
    } else if (!arg.startsWith("-") && rootDir === ".") {
      rootDir = arg;
    }
  }

  const resolvedRoot = resolve(process.cwd(), rootDir);
  const resolvedOut = outDir ? resolve(process.cwd(), outDir) : resolve(resolvedRoot, "generated");

  if (command === "compile") {
    const result = await compileProject({
      rootDir: resolvedRoot,
      outDir: resolvedOut,
      strict,
      moduleBoundaryPreset: preset,
    });

    for (const diag of result.diagnostics) {
      const loc = diag.file ? ` ${diag.file}${diag.line ? `:${diag.line}` : ""}` : "";
      const log = diag.severity === "error" ? console.error : console.warn;
      log(`[${diag.severity}] ${diag.code}${loc}: ${diag.message}`);
    }

    const errors = result.diagnostics.filter((d) => d.severity === "error");
    if (errors.length > 0) {
      console.error(`\n编译失败：共有 ${errors.length} 个错误。`);
      process.exit(1);
    }

    console.log(`\n编译成功！写入产物：\n${result.written.map((f) => `  - ${f}`).join("\n")}`);
  } else {
    const result = await checkProject({
      rootDir: resolvedRoot,
      outDir: resolvedOut,
      strict,
      moduleBoundaryPreset: preset,
    });

    for (const diag of result.diagnostics) {
      const loc = diag.file ? ` ${diag.file}${diag.line ? `:${diag.line}` : ""}` : "";
      const log = diag.severity === "error" ? console.error : console.warn;
      log(`[${diag.severity}] ${diag.code}${loc}: ${diag.message}`);
    }

    const errors = result.diagnostics.filter((d) => d.severity === "error");
    if (errors.length > 0) {
      console.error(`\n门禁校验失败：共有 ${errors.length} 个错误。`);
      process.exit(1);
    }

    if (!result.upToDate) {
      console.error("\n产物漂移检测失败：");
      for (const mismatch of result.mismatches) {
        console.error(`  - ${mismatch}`);
      }
      console.error("请运行编译命令并提交最新生成代码。");
      process.exit(1);
    }

    console.log("产物校验通过：磁盘文件与编译输出完全一致，无漂移。");
  }
}

run().catch((err) => {
  console.error("未捕获的错误：", err);
  process.exit(1);
});
