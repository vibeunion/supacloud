import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import {
    analyzeProject,
    compileProject,
    validateGraph,
    type Diagnostic,
    type ModuleNode,
} from "@supacloud/compiler";
import { optional, stringEnum, withDescription } from "../schema";
import type { ToolSchema } from "../schema";

type ToolServer = {
    tool: (
        name: string,
        description: string,
        schema: ToolSchema,
        callback: (requestArguments: AppToolArguments) => Promise<unknown>,
    ) => void;
};

export interface AppToolArguments {
    action: "generate" | "compile" | "check" | "graph" | "explain";
    kind?: "module" | "command" | "query" | "controller";
    name?: string;
    module?: string;
    dir?: string;
    force?: boolean;
    root?: string;
    include?: string;
    out_dir?: string;
    strict?: boolean;
    format?: "text" | "json";
    target?: string;
}

interface ToolResult {
    isError: boolean;
    content: Array<{ type: "text"; text: string }>;
}

function textResult(text: string, isError = false): ToolResult {
    return { isError, content: [{ type: "text" as const, text }] };
}

/** kebab/snake/空格分隔名 → PascalCase（generate 的类名）。 */
function pascalName(name: string): string {
    const joined = name
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("");
    return joined || "App";
}

/** kebab-case → camelCase（command/query 的语义名后缀）。 */
function camelName(name: string): string {
    const pascal = pascalName(name);
    return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function requireIdentifier(value: string | undefined, flag: string): string {
    const trimmed = value?.trim();
    if (!trimmed) throw new Error(`app generate requires --${flag}`);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(trimmed)) {
        throw new Error(`Invalid --${flag} value: ${value}`);
    }
    return trimmed;
}

async function writeScaffold(path: string, content: string, force: boolean): Promise<"created" | "overwritten"> {
    if (existsSync(path)) {
        if (!force) {
            throw new Error(`File already exists: ${path}（使用 --force 覆盖）`);
        }
        await writeFile(path, content, "utf8");
        return "overwritten";
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    return "created";
}

function moduleScaffold(name: string): string {
    return `import { Module } from "@supacloud/app";

@Module({
    name: ${JSON.stringify(name)},
    providers: [],
})
export class ${pascalName(name)}Module {}
`;
}

function commandScaffold(moduleName: string, name: string): string {
    return `import { Command, Injectable } from "@supacloud/app";

@Injectable()
@Command({
    name: ${JSON.stringify(`${moduleName}.${camelName(name)}`)},
    // TODO: 声明业务权限标识（如 ${moduleName}.${camelName(name)}）
    permission: "TODO",
})
export class ${pascalName(name)}Command {}
`;
}

function queryScaffold(moduleName: string, name: string): string {
    return `import { Injectable, Query } from "@supacloud/app";

@Injectable()
@Query({ name: ${JSON.stringify(`${moduleName}.${camelName(name)}`)} })
export class ${pascalName(name)}Query {}
`;
}

function controllerScaffold(moduleName: string): string {
    return `import { Controller } from "@supacloud/app";

@Controller("/${moduleName}")
export class ${pascalName(moduleName)}Controller {}
`;
}

async function generateScaffold(args: AppToolArguments): Promise<ToolResult> {
    const kind = args.kind;
    if (!kind) throw new Error("app generate requires --kind (module|command|query|controller)");
    const root = resolve(args.root || process.cwd());
    const dir = args.dir || "src/features";

    if (kind === "module") {
        const name = requireIdentifier(args.name, "name");
        const path = join(root, dir, name, `${name}.module.ts`);
        const status = await writeScaffold(path, moduleScaffold(name), args.force === true);
        return textResult(`✅ ${status}: ${path}`);
    }

    const moduleName = requireIdentifier(args.module, "module");
    const name = kind === "controller" ? moduleName : requireIdentifier(args.name, "name");
    const fileName = kind === "controller"
        ? `${moduleName}.controller.ts`
        : `${name}.${kind}.ts`;
    const subdir = kind === "command" ? "commands" : kind === "query" ? "queries" : "";
    const path = join(root, dir, moduleName, subdir, fileName);
    if (kind === "controller" && existsSync(path)) {
        throw new Error(`Controller already exists: ${path}（请手工合并路由到现有 controller）`);
    }
    const content = kind === "command"
        ? commandScaffold(moduleName, name)
        : kind === "query"
            ? queryScaffold(moduleName, name)
            : controllerScaffold(moduleName);
    const status = await writeScaffold(path, content, args.force === true);
    return textResult(`✅ ${status}: ${path}`);
}

function formatDiagnostic(diagnostic: Diagnostic): string {
    const location = diagnostic.file
        ? ` ${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ""}`
        : "";
    return `${diagnostic.severity} ${diagnostic.code}${location} ${diagnostic.message}`;
}

function formatDiagnostics(diagnostics: Diagnostic[]): string {
    if (diagnostics.length === 0) return "no diagnostics";
    return diagnostics.map(formatDiagnostic).join("\n");
}

function parseInclude(include: string | undefined): string[] | undefined {
    const patterns = include?.split(",").map((entry) => entry.trim()).filter(Boolean);
    return patterns && patterns.length > 0 ? patterns : undefined;
}

async function runCompile(args: AppToolArguments): Promise<ToolResult> {
    const root = resolve(args.root || process.cwd());
    const outDir = resolve(args.out_dir || join(root, "generated"));
    const result = await compileProject({
        rootDir: root,
        include: parseInclude(args.include),
        outDir,
        strict: args.strict === true,
    });
    const hasError = result.diagnostics.some((diagnostic) => diagnostic.severity === "error");
    const text = [
        formatDiagnostics(result.diagnostics),
        "",
        `written (${result.written.length}):`,
        ...result.written.map((path) => `  ${path}`),
    ].join("\n");
    return textResult(text, hasError);
}

async function runCheck(args: AppToolArguments): Promise<ToolResult> {
    const root = resolve(args.root || process.cwd());
    const graph = await analyzeProject(root, parseInclude(args.include));
    const diagnostics: Diagnostic[] = [
        ...(graph.diagnostics ?? []),
        ...validateGraph(graph, args.strict === true),
    ];
    if (args.strict === true) {
        for (const diagnostic of diagnostics) {
            if (diagnostic.severity === "warn") diagnostic.severity = "error";
        }
    }
    const hasError = diagnostics.some((diagnostic) => diagnostic.severity === "error");
    const summary = `checked ${graph.modules.length} module(s), no files written`;
    return textResult(`${formatDiagnostics(diagnostics)}\n\n${summary}`, hasError);
}

interface AppManifest {
    version: number;
    modules: ModuleNode[];
    externalTokens: string[];
}

async function readManifest(root: string): Promise<AppManifest> {
    const manifestPath = join(root, "generated", "app.manifest.json");
    if (!existsSync(manifestPath)) {
        throw new Error(`Manifest not found: ${manifestPath}（先运行 app compile 生成）`);
    }
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as AppManifest;
    if (!Array.isArray(parsed.modules)) {
        throw new Error(`Invalid manifest: ${manifestPath}`);
    }
    return parsed;
}

function formatGraphText(manifest: AppManifest): string {
    const lines: string[] = [`application (${manifest.modules.length} module(s))`];
    for (const module of manifest.modules) {
        lines.push(`└─ ${module.name} (${module.file}:${module.line})`);
        if (module.imports.length > 0) lines.push(`   imports: ${module.imports.join(", ")}`);
        for (const provider of module.providers) {
            lines.push(`   provider: ${provider.token} (${provider.kind}, scope=${provider.scope})`);
        }
        for (const controller of module.controllers) {
            lines.push(`   controller: ${controller.className} ${controller.path} (scope=${controller.scope})`);
            for (const route of controller.routes) {
                lines.push(`     route: ${route.method} ${route.path} -> ${route.handler}`);
            }
        }
        for (const command of module.commands) {
            lines.push(`   command: ${command.name} (${command.className})`);
        }
        for (const query of module.queries) {
            lines.push(`   query: ${query.name} (${query.className})`);
        }
        if (module.exports.length > 0) lines.push(`   exports: ${module.exports.join(", ")}`);
    }
    if (manifest.externalTokens.length > 0) {
        lines.push(`externalTokens: ${manifest.externalTokens.join(", ")}`);
    }
    return lines.join("\n");
}

async function runGraph(args: AppToolArguments): Promise<ToolResult> {
    const root = resolve(args.root || process.cwd());
    const manifest = await readManifest(root);
    if (args.format === "json") return textResult(JSON.stringify(manifest, null, 2));
    return textResult(formatGraphText(manifest));
}

/** token → 依赖它的 provider/controller 所属模块与名称（反向索引）。 */
function reverseDependencies(manifest: AppManifest, token: string): string[] {
    const dependents: string[] = [];
    for (const module of manifest.modules) {
        for (const provider of module.providers) {
            if (provider.token !== token && provider.deps.includes(token)) {
                dependents.push(`${module.name}/${provider.token}`);
            }
        }
        for (const controller of module.controllers) {
            if (controller.deps.includes(token)) {
                dependents.push(`${module.name}/${controller.className}`);
            }
        }
    }
    return dependents;
}

function explainProvider(manifest: AppManifest, module: ModuleNode, index: number): string {
    const provider = module.providers[index];
    const lines = [
        `对象: ${provider.token}`,
        `类型: provider (${provider.kind})`,
        `所属模块: ${module.name}`,
        `scope: ${provider.scope}`,
        `位置: ${provider.file}:${provider.line}`,
        `deps: ${provider.deps.length > 0 ? provider.deps.join(", ") : "(none)"}`,
    ];
    if (provider.useClass) lines.push(`useClass: ${provider.useClass}`);
    if (provider.useFactoryName) lines.push(`useFactory: ${provider.useFactoryName}`);
    if (provider.useExisting) lines.push(`useExisting: ${provider.useExisting}`);
    lines.push(`exported: ${provider.exported}`);
    const dependents = reverseDependencies(manifest, provider.token);
    lines.push(`被依赖: ${dependents.length > 0 ? dependents.join(", ") : "(none)"}`);
    return lines.join("\n");
}

function explainController(manifest: AppManifest, module: ModuleNode, index: number): string {
    const controller = module.controllers[index];
    const lines = [
        `对象: ${controller.className}`,
        "类型: controller",
        `所属模块: ${module.name}`,
        `路径: ${controller.path}`,
        `scope: ${controller.scope}`,
        `deps: ${controller.deps.length > 0 ? controller.deps.join(", ") : "(none)"}`,
    ];
    for (const route of controller.routes) {
        lines.push(`路由: ${route.method} ${controller.path}${route.path} -> ${route.handler}`);
    }
    return lines.join("\n");
}

async function runExplain(args: AppToolArguments): Promise<ToolResult> {
    const target = args.target?.trim();
    if (!target) throw new Error("app explain requires --target（provider 类名 / token 名 / command 名）");
    const root = resolve(args.root || process.cwd());
    const manifest = await readManifest(root);

    for (const module of manifest.modules) {
        const providerIndex = module.providers.findIndex(
            (provider) => provider.token === target || provider.useClass === target,
        );
        if (providerIndex >= 0) return textResult(explainProvider(manifest, module, providerIndex));

        const controllerIndex = module.controllers.findIndex(
            (controller) => controller.className === target,
        );
        if (controllerIndex >= 0) return textResult(explainController(manifest, module, controllerIndex));

        const command = module.commands.find(
            (entry) => entry.name === target || entry.className === target,
        );
        if (command) {
            const lines = [
                `对象: ${command.name}`,
                "类型: command",
                `所属模块: ${module.name}`,
                `类: ${command.className}`,
            ];
            if (command.permission) lines.push(`permission: ${command.permission}`);
            if (command.transaction) lines.push(`transaction: ${command.transaction}`);
            if (command.audit) lines.push(`audit: ${command.audit}`);
            if (command.idempotency) lines.push(`idempotency: ${command.idempotency}`);
            const dependents = reverseDependencies(manifest, command.className);
            lines.push(`被依赖: ${dependents.length > 0 ? dependents.join(", ") : "(none)"}`);
            return textResult(lines.join("\n"));
        }

        const query = module.queries.find(
            (entry) => entry.name === target || entry.className === target,
        );
        if (query) {
            return textResult([
                `对象: ${query.name}`,
                "类型: query",
                `所属模块: ${module.name}`,
                `类: ${query.className}`,
            ].join("\n"));
        }
    }

    if (manifest.externalTokens.includes(target)) {
        const dependents = reverseDependencies(manifest, target);
        return textResult([
            `对象: ${target}`,
            "类型: externalToken（平台注入，无模块提供）",
            `被依赖: ${dependents.length > 0 ? dependents.join(", ") : "(none)"}`,
        ].join("\n"));
    }

    return textResult(`未找到对象: ${target}`, true);
}

export function registerAppTools(server: ToolServer): void {
    server.tool(
        "app",
        "Local @supacloud/app framework commands: scaffold, compile, check, graph and explain. Actions: generate, compile, check, graph, explain",
        {
            action: withDescription(stringEnum(["generate", "compile", "check", "graph", "explain"]), "App action"),
            kind: optional(stringEnum(["module", "command", "query", "controller"]), "[generate] Scaffold kind"),
            name: optional(Type.String(), "[generate] Object name (module name / command / query name)"),
            module: optional(Type.String(), "[generate] Target feature module (required for command/query/controller)"),
            dir: optional(Type.String(), "[generate] Feature root directory (default: src/features)"),
            force: optional(Type.Boolean(), "[generate] Overwrite existing files"),
            root: optional(Type.String(), "[generate/compile/check/graph/explain] Project root (default: current directory)"),
            include: optional(Type.String(), "[compile/check] Comma-separated glob patterns for source files"),
            out_dir: optional(Type.String(), "[compile] Output directory (default: <root>/generated)"),
            strict: optional(Type.Boolean(), "[compile/check] Promote warnings to errors"),
            format: optional(stringEnum(["text", "json"]), "[graph] Output format (default: text)"),
            target: optional(Type.String(), "[explain] Provider class name / token name / command name"),
        },
        async (request) => {
            switch (request.action) {
                case "generate": return generateScaffold(request);
                case "compile": return runCompile(request);
                case "check": return runCheck(request);
                case "graph": return runGraph(request);
                case "explain": return runExplain(request);
                default:
                    return textResult(`Unknown app action: ${String(request.action)}`, true);
            }
        },
    );
}

// 供测试与内部复用
export const __internal = {
    pascalName,
    camelName,
    formatGraphText,
    reverseDependencies,
};
