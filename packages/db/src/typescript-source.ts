/** Lightweight TS 7 AST entrypoints for modules that must bundle without the full tooling surface. */
import { API } from "typescript/async";
import { type Node, type ScriptKind, type SourceFile } from "typescript/ast";

/** Keep the parser and remote lease alive for the whole AST visit. */
export async function withSourceFile<T>(
  fileName: string,
  text: string,
  visit: (source: SourceFile) => T | Promise<T>,
  scriptKind?: ScriptKind,
): Promise<T> {
  await using api = new API();
  await using lease = await api.createSourceFile(fileName, text, { scriptKind });
  return await visit(lease.sourceFile);
}

/** Parse local syntax only; callers must finish AST work before the returned file is released remotely. */
export async function createSourceFile(fileName: string, text: string, _target?: number, _parents = true,
  scriptKind?: ScriptKind): Promise<SourceFile> {
  return await withSourceFile(fileName, text, source => source, scriptKind);
}

export function forEachChild<T>(node: Node, visit: (child: Node) => T): T | undefined { return node.forEachChild(visit); }
