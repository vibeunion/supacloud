import { createHash } from "node:crypto";
import * as ts from "@typescript/typescript6";

export type TraitKind =
  | "module"
  | "injectable"
  | "controller"
  | "command"
  | "query"
  | "defineModule"
  | "injectionToken";

export interface TraitRecord {
  kind: TraitKind;
  name: string;
  file: string;
  start: number;
  end: number;
  fingerprint: string;
}

export interface TraitCompilation {
  byFile: Map<string, TraitRecord[]>;
  all: TraitRecord[];
}

export interface TraitHandler {
  readonly kind: TraitKind;
  detect(node: ts.Node): string | undefined;
}

const DECORATOR_TRAITS: Record<string, TraitKind> = {
  Module: "module",
  Injectable: "injectable",
  Controller: "controller",
  Command: "command",
  Query: "query",
};

export class TraitCompiler {
  private readonly handlers: readonly TraitHandler[];

  constructor(handlers: readonly TraitHandler[] = createDefaultTraitHandlers()) {
    this.handlers = handlers;
  }

  /**
   * Angular-style local metadata compiler.
   *
   * This pass is intentionally syntax-only. It discovers candidate declarations
   * cheaply; handlers that need symbols or types run later against the Program's
   * TypeChecker.
   */
  compile(
    program: ts.Program,
    previous: TraitCompilation | undefined,
    changedFiles: Set<string>,
  ): TraitCompilation {
    const byFile = new Map<string, TraitRecord[]>();

    for (const sourceFile of program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile || sourceFile.fileName.includes("/node_modules/")) continue;
      const previousTraits = previous?.byFile.get(sourceFile.fileName);
      if (previousTraits && !changedFiles.has(sourceFile.fileName)) {
        byFile.set(sourceFile.fileName, previousTraits);
        continue;
      }
      byFile.set(sourceFile.fileName, this.compileSourceFile(sourceFile));
    }

    const all = [...byFile.values()].flat().sort((a, b) =>
      a.file.localeCompare(b.file) || a.start - b.start || a.kind.localeCompare(b.kind),
    );
    return { byFile, all };
  }

  private compileSourceFile(sourceFile: ts.SourceFile): TraitRecord[] {
    const traits: TraitRecord[] = [];
    const visit = (node: ts.Node): void => {
      for (const handler of this.handlers) {
        const name = handler.detect(node);
        if (name) traits.push(record(handler.kind, name, sourceFile, node));
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return traits;
  }
}

export function compileTraits(
  program: ts.Program,
  previous: TraitCompilation | undefined,
  changedFiles: Set<string>,
): TraitCompilation {
  return new TraitCompiler().compile(program, previous, changedFiles);
}

function record(
  kind: TraitKind,
  name: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
): TraitRecord {
  const text = node.getText(sourceFile);
  return {
    kind,
    name,
    file: sourceFile.fileName,
    start: node.getStart(sourceFile),
    end: node.end,
    fingerprint: createHash("sha1").update(`${kind}:${text}`).digest("hex"),
  };
}

function decoratorName(decorator: ts.Decorator): string {
  return expressionName(
    ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression,
  );
}

function expressionName(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return "";
}

function createDefaultTraitHandlers(): TraitHandler[] {
  return [
    {
      kind: "module",
      detect: decoratedDeclaration("Module"),
    },
    {
      kind: "injectable",
      detect: decoratedDeclaration("Injectable"),
    },
    {
      kind: "controller",
      detect: decoratedDeclaration("Controller"),
    },
    {
      kind: "command",
      detect: decoratedDeclaration("Command"),
    },
    {
      kind: "query",
      detect: decoratedDeclaration("Query"),
    },
    {
      kind: "defineModule",
      detect: (node) => {
        if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return undefined;
        const initializer = node.initializer;
        return initializer && ts.isCallExpression(initializer) && expressionName(initializer.expression) === "defineModule"
          ? node.name.text
          : undefined;
      },
    },
    {
      kind: "injectionToken",
      detect: (node) => {
        if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return undefined;
        const initializer = node.initializer;
        return initializer && ts.isNewExpression(initializer) && expressionName(initializer.expression) === "InjectionToken"
          ? node.name.text
          : undefined;
      },
    },
  ];
}

function decoratedDeclaration(decorator: string): (node: ts.Node) => string | undefined {
  return (node) => {
    if (!ts.isClassDeclaration(node) || !node.name) return undefined;
    return (ts.getDecorators(node) ?? []).some((item) => decoratorName(item) === decorator)
      ? node.name.text
      : undefined;
  };
}
