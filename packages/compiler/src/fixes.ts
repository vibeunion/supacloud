import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import * as ts from "@typescript/typescript6";
import type { DiagnosticFix } from "./types";

export interface ApplyDiagnosticFixOptions {
  rootDir?: string;
  /** Preview by default; set false to write. */
  dryRun?: boolean;
  permission?: string;
}

export interface AppliedDiagnosticFix {
  file: string;
  changed: boolean;
  content: string;
}

export async function applyDiagnosticFix(
  fix: DiagnosticFix,
  options: ApplyDiagnosticFixOptions = {},
): Promise<AppliedDiagnosticFix> {
  if (!fix || typeof fix.targetFile !== "string") throw new Error("Invalid DiagnosticFix");
  const root = await realpath(options.rootDir ?? process.cwd());
  const file = resolve(root, fix.targetFile);
  const stat = await lstat(file);
  const resolved = await realpath(file);
  const relativePath = relative(root, resolved);
  if (stat.isSymbolicLink() || !stat.isFile() || isAbsolute(relativePath) ||
    relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error("Fix target must be a regular file inside rootDir");
  }
  const original = await readFile(file, "utf8");
  let source = parse(file, original);
  let content: string;

  switch (fix.type) {
    case "set_command_mode": {
      if ((fix.property !== "transaction" && fix.property !== "idempotency") ||
        (fix.value !== "required" && fix.value !== "none")) {
        throw new Error("Command mode fix requires an explicit property and policy value");
      }
      const object = decoratorObject(findClass(source, fix.command), "Command");
      const current = property(object, fix.property);
      if (!current || current.initializer.getText(source) !== fix.expectedExpression) {
        throw new Error("Command mode changed since diagnosis; analyze the project again");
      }
      content = replaceProperty(source, object, fix.property, ts.factory.createStringLiteral(fix.value));
      break;
    }
    case "add_module_import": {
      if (!fix.importPath || !fix.symbol) throw new Error("Module fix requires importPath and symbol");
      identifier(fix.symbol);
      const withImport = importSymbol(source, fix.importPath, fix.symbol);
      source = parse(file, withImport);
      const object = unique(
        moduleObjects(source).filter((candidate) =>
          !fix.targetModule || stringProperty(candidate, "name") === fix.targetModule),
        "target module",
      );
      const imports = property(object, "imports");
      if (imports && !ts.isArrayLiteralExpression(imports.initializer)) {
        throw new Error("Module imports must be a static array");
      }
      const values = imports && ts.isArrayLiteralExpression(imports.initializer)
        ? imports.initializer.elements
        : [];
      if (values.some(ts.isSpreadElement)) throw new Error("Module imports cannot contain spread elements");
      content = values.some((value) => ts.isIdentifier(value) && value.text === fix.symbol)
        ? withImport
        : replaceProperty(source, object, "imports", ts.factory.createArrayLiteralExpression([
          ...values,
          ts.factory.createIdentifier(fix.symbol),
        ]));
      break;
    }
    case "add_command_permission": {
      const permission = options.permission ?? fix.permission;
      if (!permission?.trim()) {
        throw new Error("Permission fix requires an explicit permission; privileges are never inferred");
      }
      const command = findClass(source, fix.command);
      const object = decoratorObject(command, "Command");
      const current = property(object, "permission");
      if (current && (!ts.isStringLiteral(current.initializer) || current.initializer.text !== permission)) {
        throw new Error("Command permission already exists with a different value");
      }
      content = current ? original : replaceProperty(source, object, "permission", ts.factory.createStringLiteral(permission));
      break;
    }
    case "add_route_parameter_binding": {
      const controller = findClass(source, fix.controller);
      const method = unique(controller.members.filter((member): member is ts.MethodDeclaration =>
        ts.isMethodDeclaration(member) && nameOf(member.name) === fix.route), "route handler");
      const parameter = unique(method.parameters.filter((candidate) =>
        ts.isIdentifier(candidate.name) && candidate.name.text === fix.parameter), "same-named route parameter");
      const binding = fix.binding === "param" ? "Param" : fix.binding === "query" ? "Query" : undefined;
      if (!binding) throw new Error("Invalid route binding");
      const decorators = ts.getDecorators(parameter) ?? [];
      if (decorators.length > 0) throw new Error("Parameter already has a decorator");
      const framework = unique(source.statements.filter((statement) =>
        ts.isImportDeclaration(statement) &&
        statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings) &&
        statement.importClause.namedBindings.elements.some((element) =>
          ["Controller", "Get", "Post", "Put", "Patch", "Delete", "Head", "Options"].includes(element.name.text)),
      ), "framework import");
      if (!ts.isImportDeclaration(framework) || !ts.isStringLiteral(framework.moduleSpecifier)) {
        throw new Error("Framework import must be static");
      }
      const edited = original.slice(0, parameter.getStart(source)) +
        `@${binding}(${JSON.stringify(fix.parameter)}) ` +
        original.slice(parameter.getStart(source));
      content = importSymbol(parse(file, edited), framework.moduleSpecifier.text, binding);
      break;
    }
    default:
      throw new Error(`Diagnostic fix '${fix.type}' requires a manual semantic decision; no files changed`);
  }
  parse(file, content);
  const result = { file, changed: content !== original, content };
  if (options.dryRun === false && result.changed) {
    const temporary = `${file}.supacloud-fix-${randomUUID()}`;
    try {
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: stat.mode });
      if (await readFile(file, "utf8") !== original) throw new Error("Target changed while preparing the fix");
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  return result;
}

function parse(file: string, text: string): ts.SourceFile {
  const result = ts.transpileModule(text, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, experimentalDecorators: true },
  });
  if (result.diagnostics?.some((item) => item.category === ts.DiagnosticCategory.Error)) {
    throw new Error("Cannot fix syntactically invalid TypeScript");
  }
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function unique<T>(items: readonly T[], description: string): T {
  if (items.length !== 1) throw new Error(`Expected exactly one ${description}; found ${items.length}`);
  return items[0];
}

function identifier(value: string): void {
  if (!/^[A-Za-z_$][\w$]*$/.test(value)) throw new Error(`Invalid identifier '${value}'`);
}

function nameOf(name: ts.PropertyName | undefined): string {
  if (!name) return "";
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : "";
}

function property(object: ts.ObjectLiteralExpression, key: string): ts.PropertyAssignment | undefined {
  if (object.properties.some((item) => !ts.isPropertyAssignment(item) || ts.isComputedPropertyName(item.name))) {
    throw new Error("Fix requires explicit static object properties");
  }
  const values = object.properties.filter((item): item is ts.PropertyAssignment =>
    ts.isPropertyAssignment(item) && nameOf(item.name) === key);
  if (values.length > 1) throw new Error(`Duplicate '${key}' property`);
  return values[0];
}

function stringProperty(object: ts.ObjectLiteralExpression, key: string): string | undefined {
  const value = property(object, key)?.initializer;
  return value && ts.isStringLiteral(value) ? value.text : undefined;
}

function replaceProperty(
  source: ts.SourceFile,
  object: ts.ObjectLiteralExpression,
  key: string,
  value: ts.Expression,
): string {
  const previous = property(object, key);
  const replacement = ts.factory.createPropertyAssignment(key, value);
  const properties = object.properties.map((item) => item === previous ? replacement : item);
  if (!previous) properties.push(replacement);
  const updated = ts.factory.updateObjectLiteralExpression(object, properties);
  return source.text.slice(0, object.getStart(source)) +
    ts.createPrinter().printNode(ts.EmitHint.Expression, updated, source) +
    source.text.slice(object.end);
}

function findClass(source: ts.SourceFile, name: string): ts.ClassDeclaration {
  return unique(source.statements.filter((statement): statement is ts.ClassDeclaration =>
    ts.isClassDeclaration(statement) && statement.name?.text === name), `class '${name}'`);
}

function decoratorObject(node: ts.ClassDeclaration, name: string): ts.ObjectLiteralExpression {
  const decorator = unique((ts.getDecorators(node) ?? []).filter((item) =>
    ts.isCallExpression(item.expression) && item.expression.expression.getText() === name), `@${name} decorator`);
  const argument = ts.isCallExpression(decorator.expression) ? decorator.expression.arguments[0] : undefined;
  if (!argument || !ts.isObjectLiteralExpression(argument)) throw new Error(`@${name} requires a static object`);
  return argument;
}

function moduleObjects(source: ts.SourceFile): ts.ObjectLiteralExpression[] {
  const result: ts.ObjectLiteralExpression[] = [];
  for (const statement of source.statements) {
    if (ts.isClassDeclaration(statement) && (ts.getDecorators(statement) ?? []).some((item) =>
      ts.isCallExpression(item.expression) && item.expression.expression.getText() === "Module")) {
      result.push(decoratorObject(statement, "Module"));
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const call = declaration.initializer;
        if (call && ts.isCallExpression(call) &&
          ["defineModule", "defineFeatureSlice"].includes(call.expression.getText()) &&
          call.arguments[0] && ts.isObjectLiteralExpression(call.arguments[0])) {
          result.push(call.arguments[0]);
        }
      }
    }
  }
  return result;
}

function importSymbol(source: ts.SourceFile, path: string, symbol: string): string {
  identifier(symbol);
  const current = resolve(source.fileName).replace(/\.(tsx?|mts|cts)$/, "");
  const target = resolve(dirname(source.fileName), path).replace(/\.(tsx?|mts|cts)$/, "");
  if (current === target) return source.text;
  const matches = source.statements.filter((item) =>
    ts.isImportDeclaration(item) && ts.isStringLiteral(item.moduleSpecifier) && item.moduleSpecifier.text === path);
  if (matches.length > 1) throw new Error(`Ambiguous imports from '${path}'`);
  const match = matches[0];
  if (match && ts.isImportDeclaration(match) && match.importClause?.namedBindings &&
    ts.isNamedImports(match.importClause.namedBindings) && !match.importClause.isTypeOnly) {
    if (match.importClause.namedBindings.elements.some((item) => item.name.text === symbol)) return source.text;
    const bindings = match.importClause.namedBindings;
    const updated = ts.factory.updateNamedImports(bindings, [
      ...bindings.elements,
      ts.factory.createImportSpecifier(false, undefined, ts.factory.createIdentifier(symbol)),
    ]);
    return source.text.slice(0, bindings.getStart(source)) +
      ts.createPrinter().printNode(ts.EmitHint.Unspecified, updated, source) +
      source.text.slice(bindings.end);
  }
  if (match) throw new Error(`Import from '${path}' is not a named value import`);
  return `import { ${symbol} } from ${JSON.stringify(path)};\n${source.text}`;
}
