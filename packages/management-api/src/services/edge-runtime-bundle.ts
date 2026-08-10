import { parse } from "acorn";

type SyntaxNode = {
  type: string;
  start: number;
  end: number;
  loc?: { start: { line: number } };
  [property: string]: unknown;
};

type StaticStringBinding = {
  moduleSpecifier: string;
  declarations: number;
  writes: number;
};

type SourceReplacement = {
  start: number;
  end: number;
  code: string;
};

export type EdgeRuntimeBundleNormalization = {
  code: string;
  importCount: number;
};

function isSyntaxNode(candidate: unknown): candidate is SyntaxNode {
  return !!candidate
    && typeof candidate === "object"
    && "type" in candidate
    && typeof candidate.type === "string"
    && "start" in candidate
    && typeof candidate.start === "number"
    && "end" in candidate
    && typeof candidate.end === "number";
}

function syntaxChildren(node: SyntaxNode): SyntaxNode[] {
  const children: SyntaxNode[] = [];
  for (const property of Object.values(node)) {
    if (isSyntaxNode(property)) children.push(property);
    if (Array.isArray(property)) children.push(...property.filter(isSyntaxNode));
  }
  return children;
}

function walkSyntax(node: SyntaxNode, visit: (syntaxNode: SyntaxNode) => void): void {
  visit(node);
  for (const child of syntaxChildren(node)) walkSyntax(child, visit);
}

function objectPatternIdentifiers(property: unknown): string[] {
  if (!isSyntaxNode(property)) return [];
  if (property.type === "RestElement") return patternIdentifiers(property.argument);
  return property.type === "Property" ? patternIdentifiers(property.value) : [];
}

function patternIdentifiers(pattern: unknown): string[] {
  if (!isSyntaxNode(pattern)) return [];
  if (pattern.type === "Identifier") return [String(pattern.name)];
  if (pattern.type === "RestElement") return patternIdentifiers(pattern.argument);
  if (pattern.type === "AssignmentPattern") return patternIdentifiers(pattern.left);
  if (pattern.type === "ArrayPattern") return (pattern.elements as unknown[]).flatMap(patternIdentifiers);
  if (pattern.type === "ObjectPattern") {
    return (pattern.properties as unknown[]).flatMap(objectPatternIdentifiers);
  }
  return [];
}

function declarationIdentifiers(node: SyntaxNode): string[] {
  if (node.type === "VariableDeclarator") return patternIdentifiers(node.id);
  if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)) {
    const parameters = Array.isArray(node.params) ? node.params.flatMap(patternIdentifiers) : [];
    return [...patternIdentifiers(node.id), ...parameters];
  }
  if (["ClassDeclaration", "ClassExpression"].includes(node.type)) return patternIdentifiers(node.id);
  if (["ImportSpecifier", "ImportDefaultSpecifier", "ImportNamespaceSpecifier"].includes(node.type)) {
    return patternIdentifiers(node.local);
  }
  return node.type === "CatchClause" ? patternIdentifiers(node.param) : [];
}

function assignedIdentifiers(node: SyntaxNode): string[] {
  if (node.type === "AssignmentExpression") return patternIdentifiers(node.left);
  if (node.type === "UpdateExpression") return patternIdentifiers(node.argument);
  if (["ForInStatement", "ForOfStatement"].includes(node.type)
    && isSyntaxNode(node.left)
    && node.left.type !== "VariableDeclaration") {
    return patternIdentifiers(node.left);
  }
  return [];
}

function parseBundle(code: string): SyntaxNode {
  return parse(code, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowHashBang: true,
    locations: true,
  }) as unknown as SyntaxNode;
}

function staticStringBinding(declaration: SyntaxNode): [string, StaticStringBinding] | null {
  if (!isSyntaxNode(declaration.id) || declaration.id.type !== "Identifier") return null;
  if (!isSyntaxNode(declaration.init) || declaration.init.type !== "Literal") return null;
  if (typeof declaration.init.value !== "string") return null;
  return [
    String(declaration.id.name),
    {
      moduleSpecifier: declaration.init.value,
      declarations: 0,
      writes: 0,
    },
  ];
}

function topLevelStringBindings(program: SyntaxNode): Map<string, StaticStringBinding> {
  const bindings = new Map<string, StaticStringBinding>();
  const statements = Array.isArray(program.body) ? program.body.filter(isSyntaxNode) : [];
  for (const statement of statements.filter((entry) => entry.type === "VariableDeclaration")) {
    // An uninitialized top-level var resolves to undefined; lexical bindings would throw in TDZ.
    if (statement.kind !== "var") continue;
    const declarations = Array.isArray(statement.declarations) ? statement.declarations : [];
    for (const declaration of declarations.filter(isSyntaxNode)) {
      const binding = staticStringBinding(declaration);
      if (binding) bindings.set(...binding);
    }
  }
  return bindings;
}

function recordBindingUsage(program: SyntaxNode, bindings: Map<string, StaticStringBinding>): void {
  walkSyntax(program, (node) => {
    for (const name of declarationIdentifiers(node)) {
      const binding = bindings.get(name);
      if (binding) binding.declarations++;
    }
    for (const name of assignedIdentifiers(node)) {
      const binding = bindings.get(name);
      if (binding) binding.writes++;
    }
  });
}

function dynamicImports(program: SyntaxNode): SyntaxNode[] {
  const foundImports: SyntaxNode[] = [];
  walkSyntax(program, (node) => {
    if (node.type === "ImportExpression") foundImports.push(node);
  });
  return foundImports;
}

function computedDynamicImports(program: SyntaxNode): SyntaxNode[] {
  return dynamicImports(program)
    .filter((dynamicImport) => !isLiteralModuleSpecifier(dynamicImport.source));
}

function directEval(program: SyntaxNode): SyntaxNode | undefined {
  let call: SyntaxNode | undefined;
  walkSyntax(program, (node) => {
    if (call || node.type !== "CallExpression" || !isSyntaxNode(node.callee)) return;
    if (node.callee.type === "Identifier" && node.callee.name === "eval") call = node;
  });
  return call;
}

function isLiteralModuleSpecifier(source: unknown): boolean {
  if (!isSyntaxNode(source)) return false;
  if (source.type === "Literal") return typeof source.value === "string";
  return source.type === "TemplateLiteral"
    && Array.isArray(source.expressions)
    && source.expressions.length === 0;
}

function literalModuleSpecifier(source: unknown): string | null {
  if (!isSyntaxNode(source)) return null;
  if (source.type === "Literal") return typeof source.value === "string" ? source.value : null;
  if (!isLiteralModuleSpecifier(source) || !Array.isArray(source.quasis)) return null;
  const quasi = source.quasis.find(isSyntaxNode);
  if (!quasi || !quasi.value || typeof quasi.value !== "object") return null;
  const cooked = (quasi.value as Record<string, unknown>).cooked;
  return typeof cooked === "string" ? cooked : null;
}

function finalBundleImportCount(program: SyntaxNode): number {
  const moduleSpecifiers = new Set<string>();
  walkSyntax(program, (node) => {
    if (!["ImportDeclaration", "ImportExpression", "ExportNamedDeclaration", "ExportAllDeclaration"]
      .includes(node.type)) return;
    const moduleSpecifier = literalModuleSpecifier(node.source);
    if (moduleSpecifier !== null) moduleSpecifiers.add(moduleSpecifier);
  });
  return moduleSpecifiers.size;
}

function compatibilityError(node: SyntaxNode, detail: string): Error {
  const line = node.loc?.start.line;
  const location = line ? ` at bundle line ${line}` : "";
  return new Error(`Edge Runtime compatibility check failed${location}: ${detail}`);
}

function literalDynamicImport(
  code: string,
  dynamicImport: SyntaxNode,
  moduleSpecifier: string,
): string {
  const source = dynamicImport.source as SyntaxNode;
  return code.slice(dynamicImport.start, source.start)
    + JSON.stringify(moduleSpecifier)
    + code.slice(source.end, dynamicImport.end);
}

function provenImportBinding(
  dynamicImport: SyntaxNode,
  bindings: Map<string, StaticStringBinding>,
): { name: string; binding: StaticStringBinding } {
  if (!isSyntaxNode(dynamicImport.source) || dynamicImport.source.type !== "Identifier") {
    throw compatibilityError(dynamicImport, "computed dynamic imports are disabled");
  }
  const name = String(dynamicImport.source.name);
  const binding = bindings.get(name);
  if (!binding
    || binding.declarations !== 1
    || binding.writes !== 0) {
    throw compatibilityError(dynamicImport, "computed dynamic imports are disabled");
  }
  return { name, binding };
}

function computedImportReplacement(
  dynamicImport: SyntaxNode,
  bindings: Map<string, StaticStringBinding>,
  code: string,
): SourceReplacement {
  const { name, binding } = provenImportBinding(dynamicImport, bindings);
  const literalSpecifier = JSON.stringify(binding.moduleSpecifier);
  const literalImport = literalDynamicImport(code, dynamicImport, binding.moduleSpecifier);
  // import(undefined) resolves the same "undefined" specifier before this var is initialized.
  const uninitializedImport = literalDynamicImport(code, dynamicImport, "undefined");
  return {
    start: dynamicImport.start,
    end: dynamicImport.end,
    code: `(${name} === ${literalSpecifier} ? ${literalImport} : ${uninitializedImport})`,
  };
}

function applyReplacements(code: string, replacements: SourceReplacement[]): string {
  return [...replacements]
    .sort((left, right) => right.start - left.start)
    .reduce(
      (normalizedCode, replacement) => normalizedCode.slice(0, replacement.start)
        + replacement.code
        + normalizedCode.slice(replacement.end),
      code,
    );
}

function validatedFinalProgram(code: string): SyntaxNode {
  const program = parseBundle(code);
  const unsupported = dynamicImports(program)
    .find((dynamicImport) => !isLiteralModuleSpecifier(dynamicImport.source));
  if (unsupported) throw compatibilityError(unsupported, "computed dynamic imports are disabled");
  return program;
}

export function normalizeEdgeRuntimeBundle(code: string): EdgeRuntimeBundleNormalization {
  const program = parseBundle(code);
  const computedImports = computedDynamicImports(program);
  const evalCall = computedImports.length > 0 ? directEval(program) : undefined;
  if (evalCall) {
    throw compatibilityError(
      evalCall,
      "direct eval prevents proving computed dynamic import bindings are immutable",
    );
  }
  const bindings = topLevelStringBindings(program);
  recordBindingUsage(program, bindings);
  const replacements = computedImports.map((dynamicImport) => (
    computedImportReplacement(dynamicImport, bindings, code)
  ));
  const normalizedCode = applyReplacements(code, replacements);
  const finalProgram = validatedFinalProgram(normalizedCode);
  return {
    code: normalizedCode,
    importCount: finalBundleImportCount(finalProgram),
  };
}
