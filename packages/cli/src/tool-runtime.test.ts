import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "@typescript/typescript6";
import {
    parseToolArguments,
    registerTool,
    stringEnum,
    type ToolInvocation,
    type ToolServer,
    type ToolTextContent,
} from "./tool-runtime";

test("public tool runtime rejects invalid input and invalid results", async () => {
    let invoke: ToolInvocation | undefined;
    const server: ToolServer = { tool(_name, _description, _schema, callback) { invoke = callback; } };
    const schema = { action: stringEnum(["read"]) };
    let calls = 0;
    registerTool(server, "read", "", schema, async ({ action }) => {
        calls++;
        return { content: [{ type: "text", text: action }] };
    });
    if (!invoke) throw new Error("Tool was not registered");
    expect(await invoke({ action: "read" })).toEqual({ content: [{ type: "text", text: "read" }] });
    await expect(invoke({ action: "write" })).rejects.toThrow("Invalid arguments");
    await expect(invoke({ action: "read", extra: true })).rejects.toThrow("Invalid arguments");
    expect(calls).toBe(1);
    expect(() => parseToolArguments(schema, null)).toThrow("Invalid arguments");

    const invalidContent: ToolTextContent = { type: "text", text: "invalid result" };
    Object.defineProperty(invalidContent, "type", { value: "image" });
    registerTool(server, "broken", "", schema, async () => ({ content: [invalidContent] }));
    await expect(invoke({ action: "read" })).rejects.toThrow("Invalid result");
});

test("the exported tool runtime loads detached under Node and Bun without CLI side effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-tool-runtime-"));
    try {
        const packageRoot = join(root, "node_modules/@supacloud/cli");
        await mkdir(packageRoot, { recursive: true });
        const manifest = await readFile(join(import.meta.dir, "../package.json"), "utf8");
        await writeFile(join(packageRoot, "package.json"), manifest);
        const result = await Bun.build({
            entrypoints: [join(import.meta.dir, "tool-runtime.ts")],
            outdir: join(packageRoot, "dist"),
            target: "node",
        });
        expect(result.success).toBe(true);
        const script = `import {parseToolArguments, stringEnum} from "@supacloud/cli/tool-runtime";
const result = parseToolArguments({action: stringEnum(["read"])}, {action: "read"});
if (result.action !== "read") throw new Error("Invalid public runtime receipt");
console.log("tool-runtime-ready");`;
        for (const executable of ["node", process.execPath]) {
            const child = Bun.spawnSync([executable, "--input-type=module", "--eval", script], {
                cwd: root, env: { PATH: process.env["PATH"] ?? "" },
                stdout: "pipe", stderr: "pipe",
            });
            expect(new TextDecoder().decode(child.stderr)).toBe("");
            expect(child.exitCode).toBe(0);
            expect(new TextDecoder().decode(child.stdout).trim()).toBe("tool-runtime-ready");
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("public declarations retain strict callback inference for detached NodeNext consumers", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-tool-runtime-types-"));
    try {
        const packageRoot = join(root, "node_modules/@supacloud/cli");
        await mkdir(packageRoot, { recursive: true });
        await writeFile(join(packageRoot, "package.json"), await readFile(join(import.meta.dir, "../package.json")));
        await symlink(join(import.meta.dir, "../node_modules/typebox"), join(root, "node_modules/typebox"), "dir");

        const config = ts.readConfigFile(join(import.meta.dir, "../tsconfig.tool-runtime.json"), ts.sys.readFile);
        expect(config.error).toBeUndefined();
        const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(import.meta.dir, ".."));
        expect(parsed.errors).toEqual([]);
        expect(parsed.fileNames).toEqual([join(import.meta.dir, "tool-runtime.ts")]);
        const declarations = ts.createProgram(parsed.fileNames, {
            ...parsed.options,
            skipLibCheck: false,
            declaration: true,
            emitDeclarationOnly: true,
            noEmitOnError: true,
            outDir: join(packageRoot, "dist"),
        });
        expect(ts.getPreEmitDiagnostics(declarations).map(diagnostic => diagnostic.messageText)).toEqual([]);
        expect(declarations.emit().emitSkipped).toBe(false);

        const consumer = join(root, "consumer.mts");
        const setup = `import {registerTool, stringEnum, type ToolServer} from "@supacloud/cli/tool-runtime";
const server: ToolServer = {tool() {}};
const schema = {action: stringEnum(["read"])};`;
        const host = ts.createCompilerHost({});
        const read = host.readFile;
        const source = `${setup}
registerTool(server, "read", "", schema, async ({action}) => {
    const exact: "read" = action;
    return {content: [{type: "text", text: exact}]};
});
registerTool(server, "bad-input", "", schema, async (_args: {action: "write"}) => ({content: []}));
registerTool(server, "bad-result", "", schema, async () => ({content: [{type: "image"}]}));`;
        host.readFile = path => path === consumer ? source : read(path);
        const program = ts.createProgram([consumer], {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            strict: true,
            noEmit: true,
            types: [],
        }, host);
        const diagnostics = ts.getPreEmitDiagnostics(program);
        expect(diagnostics.map(diagnostic => diagnostic.code).sort()).toEqual([2322, 2345]);
        const invalidStart = source.indexOf('registerTool(server, "bad-input"');
        expect(invalidStart).toBeGreaterThan(0);
        /* Keep the valid callback in the same program so this remains a real
         * positive inference check, not only a pair of expected failures. */
        expect(diagnostics.every(diagnostic =>
            diagnostic.start === undefined || diagnostic.start >= invalidStart)).toBe(true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}, { timeout: 60_000 });
