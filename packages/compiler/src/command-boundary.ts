import * as ts from "@supacloud/db/typescript";
import { apiOrigin } from "./api-source";
import type { Diagnostic } from "./types";

interface GovernedClass {
  declaration: ts.ClassDeclaration;
  name: string;
  /** Declared durable persistence boundary (the database RPC that owns receipt, audit and transaction). */
  rpc?: string;
}
type CommandMember = ts.MethodDeclaration | ts.PropertyDeclaration;

/** A conservative source check for typed command references, not a JavaScript sandbox. */
export async function scanCommandBoundaries(
  source: ts.SourceFile,
  file: string,
  checker: ts.TypeChecker,
  commands: readonly GovernedClass[],
  boundRoutes: ReadonlyMap<ts.MethodDeclaration, string>,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const byDeclaration = new Map(commands.map((command) => [command.declaration, command]));
  const readonly = (node: ts.PropertyDeclaration): boolean =>
    node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false;
  const propertyName = (node: ts.Node | undefined): string | undefined =>
    node && (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node)) ? node.text : undefined;
  const commandMethod = async (symbol: ts.Symbol | undefined): Promise<CommandMember | undefined> => {
    for (const node of await ts.declarationsOf(symbol)) {
      if (!ts.isClassDeclaration(node.parent) || !byDeclaration.has(node.parent)) continue;
      if (ts.isMethodDeclaration(node)) return node;
      if (ts.isPropertyDeclaration(node) && (await (await checker.getTypeAtLocation(node)).getCallSignatures()).length > 0) return node;
    }
    return undefined;
  };

  // Existing durable-command facades may expose a pure forwarding method. Only
  // readonly fields initialized by the actual package factory qualify.
  const isDurableForwarder = async (method: CommandMember): Promise<boolean> => {
    if (!ts.isMethodDeclaration(method) || !method.body || method.body.statements.length !== 1 || !ts.isClassDeclaration(method.parent)) return false;
    const statement = method.body.statements[0];
    if (!statement || !ts.isReturnStatement(statement) || !statement.expression) return false;
    const expression = ts.isAwaitExpression(statement.expression) ? statement.expression.expression : statement.expression;
    if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) return false;
    const parameters = new Set(method.parameters.flatMap((parameter) =>
      ts.isIdentifier(parameter.name) && parameter.initializer === undefined ? [parameter.name.text] : []));
    if (parameters.size !== method.parameters.length
      || expression.arguments.some((argument) => !ts.isIdentifier(argument) || !parameters.has(argument.text))) return false;
    const call = expression.expression;
    if (!["execute", "lookupByReference", "reconcile"].includes(call.name.text)
      || !ts.isPropertyAccessExpression(call.expression) || call.expression.expression.kind !== ts.SyntaxKind.ThisKeyword) return false;
    const fieldName = call.expression.name.text;
    const field = method.parent.members.find((member): member is ts.PropertyDeclaration =>
      ts.isPropertyDeclaration(member) && propertyName(member.name) === fieldName && readonly(member));
    if (!field) return false;
    const initializers: ts.Expression[] = field.initializer ? [field.initializer] : [];
    for (const member of method.parent.members) {
      if (!ts.isConstructorDeclaration(member)) continue;
      for (const item of member.body?.statements ?? []) {
        if (!ts.isExpressionStatement(item) || !ts.isBinaryExpression(item.expression)) continue;
        const assignment = item.expression;
        if (assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && ts.isPropertyAccessExpression(assignment.left) && assignment.left.expression.kind === ts.SyntaxKind.ThisKeyword
          && assignment.left.name.text === fieldName) initializers.push(assignment.right);
      }
    }
    if (initializers.length !== 1 || !ts.isCallExpression(initializers[0]!)) return false;
    const origin = await apiOrigin(initializers[0]!.expression, checker);
    return (origin?.module === "@supacloud/commands"
      && ["createTransactionalCommand", "createExternalCommand"].includes(origin.name))
      || (origin?.module === "@supacloud/commands/typebox" && origin.name === "createTypeBoxTransactionalCommand");
  };
  const allowed = async (node: ts.Node, method: CommandMember): Promise<boolean> => {
    if (await isDurableForwarder(method)) return true;
    if (!ts.isClassDeclaration(method.parent)) return false;
    const command = byDeclaration.get(method.parent);
    if (!command) return false;
    // Reading a method into an alias or callback escapes the checked boundary.
    if (!ts.isCallExpression(node.parent) || node.parent.expression !== node) return false;
    // A command that declares a database RPC boundary is already durable at the
    // RPC: authorization, receipt, transaction and audit are enforced inside it,
    // and the configured adapter must satisfy every declared capability (validate.ts).
    // Extracting the method as a value still escapes this check, so callers cannot
    // launder an ungoverned invocation through the RPC-declared command.
    if (command.rpc !== undefined && propertyName(method.name) === "execute") return true;
    for (let owner = node.parent.parent; owner; owner = owner.parent) {
      if (ts.isMethodDeclaration(owner)) {
        if (owner.parent === method.parent && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
          && node.expression.kind === ts.SyntaxKind.ThisKeyword) return true;
        return boundRoutes.get(owner) === command.name;
      }
      if (ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) {
        const property = owner.parent;
        if (!ts.isPropertyAssignment(property) || propertyName(property.name) !== "handler"
          || !ts.isObjectLiteralExpression(property.parent) || !ts.isCallExpression(property.parent.parent)) return false;
        const call = property.parent.parent;
        const origin = await apiOrigin(call.expression, checker);
        const selection = property.parent.properties.find((item): item is ts.PropertyAssignment =>
          ts.isPropertyAssignment(item) && propertyName(item.name) === "command");
        return origin?.module === "@supacloud/elysia" && origin.name === "executeCompiledCommand"
          && selection !== undefined && ts.isStringLiteral(selection.initializer)
          && [command.name, command.declaration.name?.text].includes(selection.initializer.text);
      }
      if (ts.isFunctionDeclaration(owner)) return false;
    }
    return false;
  };
  const report = (node: ts.Node): void => {
    const position = source.getLineAndCharacterOfPosition(node.getStart());
    diagnostics.push({
      severity: "error", code: "command-executor-bypass", file,
      line: position.line + 1, column: position.character,
      message: "Raw command method access bypasses its declared executor boundary.",
      suggestion: "Use a durable command facade, an explicitly bound route, or executeCompiledCommand with a literal command and handler continuation. Do not extract raw command methods.",
    });
  };
  const visit = async (node: ts.Node): Promise<void> => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const symbol = ts.isPropertyAccessExpression(node) ? await checker.getSymbolAtLocation(node.name)
        : ts.isStringLiteral(node.argumentExpression) ? await (await checker.getTypeAtLocation(node.expression)).getProperty(node.argumentExpression.text) : undefined;
      const method = await commandMethod(symbol);
      if (method && !await allowed(node, method)) report(node);
      if (ts.isElementAccessExpression(node) && !ts.isStringLiteral(node.argumentExpression)) {
        const symbol = await (await checker.getTypeAtLocation(node.expression)).getSymbol();
        if ((await ts.declarationsOf(symbol)).some(decl => ts.isClassDeclaration(decl) && byDeclaration.has(decl))) report(node);
      }
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)
      && ts.isVariableDeclaration(node.parent.parent) && node.parent.parent.initializer) {
      const name = propertyName(node.propertyName ?? node.name);
      const type = await checker.getTypeAtLocation(node.parent.parent.initializer);
      const method = name ? await commandMethod(await type.getProperty(name)) : undefined;
      if (method && !await isDurableForwarder(method)) report(node);
    }
    await ts.forEachChildAsync(node, visit);
  };
  await visit(source);
  return diagnostics;
}
