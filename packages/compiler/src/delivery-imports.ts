import * as ts from "@typescript/typescript6";

/** Resolve private literal-only import wrappers without permitting an open dependency set. */
export function staticDeliveryImports(path: string, contents: Uint8Array): Uint8Array {
  if (!/\.[cm]?[jt]sx?$/.test(path)) return contents;
  const source = ts.createSourceFile(path, new TextDecoder().decode(contents), ts.ScriptTarget.Latest, true);
  const computed: ts.CallExpression[] = [];
  function scan(node: ts.Node): void {
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0];
      if (!argument || (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))) computed.push(node);
    }
    ts.forEachChild(node, scan);
  }
  scan(source);
  if (computed.length === 0) return contents;
  const reject = () => { throw new Error("Computed module loading is not supported in independent delivery bundles."); };
  if (!ts.isExternalModule(source)) return reject();

  const host = ts.createCompilerHost({ noLib: true, noResolve: true, allowJs: true });
  host.getSourceFile = (name) => name === path ? source : undefined;
  const checker = ts.createProgram([path], { noLib: true, noResolve: true, allowJs: true }, host).getTypeChecker();
  const replacements = new Map<ts.CallExpression, ts.CallExpression>();
  const removed = new Set<ts.FunctionDeclaration>();

  for (const call of computed) {
    const statement = call.parent;
    const block = statement.parent;
    const declaration = block.parent;
    if (call.expression.kind !== ts.SyntaxKind.ImportKeyword || call.arguments.length !== 1
      || !ts.isReturnStatement(statement) || !ts.isBlock(block) || block.statements.length !== 1
      || !ts.isFunctionDeclaration(declaration) || declaration.parent !== source || !declaration.name
      || declaration.modifiers?.length || declaration.asteriskToken || declaration.typeParameters?.length
      || declaration.parameters.length !== 1) return reject();
    const parameter = declaration.parameters[0];
    const argument = call.arguments[0];
    if (!parameter || !ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken
      || !argument || !ts.isIdentifier(argument)
      || checker.getSymbolAtLocation(argument) !== checker.getSymbolAtLocation(parameter.name)) return reject();
    const symbol = checker.getSymbolAtLocation(declaration.name);
    if (!symbol || symbol.declarations?.length !== 1) return reject();
    const declarationName = declaration.name;
    let references = 0;
    function visit(node: ts.Node): void {
      const referenced = ts.isIdentifier(node)
        ? ts.isShorthandPropertyAssignment(node.parent)
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : ts.isExportSpecifier(node.parent)
            ? checker.getExportSpecifierLocalTargetSymbol(node.parent)
            : checker.getSymbolAtLocation(node)
        : undefined;
      if (ts.isIdentifier(node) && node !== declarationName && referenced === symbol) {
        const use = node.parent;
        if (!ts.isCallExpression(use) || use.expression !== node || use.arguments.length !== 1
          || use.questionDotToken || use.typeArguments?.length) return reject();
        const value = use.arguments[0];
        if (!value || (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value))) return reject();
        references++;
        replacements.set(use, ts.factory.createCallExpression(call.expression, undefined, [value]));
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (references === 0) return reject();
    removed.add(declaration);
  }
  const transformed = ts.transform(source, [(context) => {
    const visit: ts.Visitor = (node) => {
      if (ts.isFunctionDeclaration(node) && removed.has(node)) return undefined;
      const replacement = ts.isCallExpression(node) ? replacements.get(node) : undefined;
      if (replacement) return replacement;
      return ts.visitEachChild(node, visit, context);
    };
    return (node) => ts.visitNode(node, visit, ts.isSourceFile) ?? node;
  }]);
  try {
    const transformedSource = transformed.transformed[0];
    if (!transformedSource) return reject();
    return new TextEncoder().encode(ts.createPrinter().printFile(transformedSource));
  } finally { transformed.dispose(); }
}
