import * as ts from "@supacloud/db/typescript";

/** Resolve private literal-only import wrappers without permitting an open dependency set. */
export async function staticDeliveryImports(path: string, contents: Uint8Array): Promise<Uint8Array> {
  if (!/\.[cm]?[jt]sx?$/.test(path)) return contents;
  const syntax = await ts.createSourceFile(path, new TextDecoder().decode(contents));
  let source: ts.SourceFile = syntax;
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

  await using program = await ts.createProgram([path], { noLib: true, noResolve: true, allowJs: true },
    { sources: new Map([[path, source.text]]) });
  const boundSource = program.getSourceFile(path);
  if (!boundSource) return reject();
  // Recollect on the bound tree: native checker handles belong to that program.
  computed.length = 0;
  source = boundSource;
  scan(source);
  const checker = program.getTypeChecker();
  const replacements = new Map<ts.CallExpression, string>();
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
      || (await checker.getSymbolAtLocation(argument)) !== (await checker.getSymbolAtLocation(parameter.name))) return reject();
    const symbol = (await checker.getSymbolAtLocation(declaration.name));
    if (!symbol || symbol.declarations?.length !== 1) return reject();
    const declarationName = declaration.name;
    let references = 0;
    async function visit(node: ts.Node): Promise<void> {
      const referenced = ts.isIdentifier(node)
        ? ts.isShorthandPropertyAssignment(node.parent)
          ? (await checker.getShorthandAssignmentValueSymbol(node.parent))
          : ts.isExportSpecifier(node.parent)
            ? (await checker.getExportSpecifierLocalTargetSymbol(node.parent))
            : (await checker.getSymbolAtLocation(node))
        : undefined;
      if (ts.isIdentifier(node) && node !== declarationName && referenced === symbol) {
        const use = node.parent;
        if (!ts.isCallExpression(use) || use.expression !== node || use.arguments.length !== 1
          || use.questionDotToken || use.typeArguments?.length) return reject();
        const value = use.arguments[0];
        if (!value || (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value))) return reject();
        references++;
        replacements.set(use, `import(${value.getText(source)})`);
      }
      (await ts.forEachChildAsync(node, visit));
    }
    (await visit(source));
    if (references === 0) return reject();
    removed.add(declaration);
  }
  const edits = [
    ...[...removed].map(node => ({ start: node.getStart(source), end: node.end, text: "" })),
    ...[...replacements].map(([node, text]) => ({ start: node.getStart(source), end: node.end, text })),
  ].sort((a, b) => b.start - a.start);
  let output = source.text;
  for (const edit of edits) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return new TextEncoder().encode(output);
}
