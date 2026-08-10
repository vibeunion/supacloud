import { parse } from "acorn";

const CONTRACT_ERROR_PREFIX = "Edge Function bundle is incompatible with the production runtime";

function contractError(reason) {
  return new Error(`${CONTRACT_ERROR_PREFIX}: ${reason}`);
}

function isAstNode(candidate) {
  return candidate !== null
    && typeof candidate === "object"
    && typeof candidate.type === "string";
}

function walkAst(node, visit) {
  visit(node);
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) {
      for (const entry of child) {
        if (isAstNode(entry)) walkAst(entry, visit);
      }
    } else if (isAstNode(child)) {
      walkAst(child, visit);
    }
  }
}

function bindingNames(pattern) {
  if (!pattern) return [];
  if (pattern.type === "ParenthesizedExpression") return bindingNames(pattern.expression);
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "RestElement") return bindingNames(pattern.argument);
  if (pattern.type === "AssignmentPattern") return bindingNames(pattern.left);
  if (pattern.type === "ArrayPattern") {
    return pattern.elements.flatMap(bindingNames);
  }
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.flatMap((property) => {
      if (property.type === "RestElement") return bindingNames(property.argument);
      return bindingNames(property.value);
    });
  }
  return [];
}

function declarationNames(node) {
  switch (node.type) {
    case "VariableDeclarator":
      return bindingNames(node.id);
    case "FunctionDeclaration":
    case "FunctionExpression":
      return [...bindingNames(node.id), ...node.params.flatMap(bindingNames)];
    case "ArrowFunctionExpression":
      return node.params.flatMap(bindingNames);
    case "ClassDeclaration":
    case "ClassExpression":
      return bindingNames(node.id);
    case "ImportSpecifier":
    case "ImportDefaultSpecifier":
    case "ImportNamespaceSpecifier":
      return bindingNames(node.local);
    case "CatchClause":
      return bindingNames(node.param);
    default:
      return [];
  }
}

function writtenNames(node) {
  if (node.type === "AssignmentExpression") return bindingNames(node.left);
  if (node.type === "UpdateExpression") return bindingNames(node.argument);
  if ((node.type === "ForInStatement" || node.type === "ForOfStatement")
    && node.left.type !== "VariableDeclaration") {
    return bindingNames(node.left);
  }
  return [];
}

function topLevelVariableDeclarations(program) {
  const declarations = [];
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;
    if (declaration?.type === "VariableDeclaration") declarations.push(declaration);
  }
  return declarations;
}

function topLevelStringBindings(program) {
  const bindings = new Map();
  for (const declaration of topLevelVariableDeclarations(program)) {
    for (const declarator of declaration.declarations) {
      if (declarator.id.type !== "Identifier") continue;
      if (declarator.init?.type !== "Literal" || typeof declarator.init.value !== "string") continue;
      bindings.set(declarator.id.name, {
        specifier: declarator.init.value,
        initializedAt: declarator.end,
      });
    }
  }
  return bindings;
}

function importExpressions(program) {
  const imports = [];
  walkAst(program, (node) => {
    if (node.type === "ImportExpression") imports.push(node);
  });
  return imports;
}

function unwrappedExpression(node) {
  let expression = node;
  while (expression.type === "ParenthesizedExpression") {
    expression = expression.expression;
  }
  return expression;
}

function isLiteralImportSource(source) {
  return literalImportSpecifier(source) !== null;
}

function literalImportSpecifier(source) {
  const expression = unwrappedExpression(source);
  if (expression.type === "Literal" && typeof expression.value === "string") {
    return expression.value;
  }
  if (expression.type === "TemplateLiteral" && expression.expressions.length === 0) {
    return expression.quasis[0].value.cooked;
  }
  return null;
}

function isDirectEvalCall(node) {
  if (node.type !== "CallExpression" || node.optional) return false;
  const callee = unwrappedExpression(node.callee);
  return callee.type === "Identifier" && callee.name === "eval";
}

function bindingSafety(program, candidateNames) {
  const declarationCounts = new Map(candidateNames.map((name) => [name, 0]));
  const written = new Set();
  let hasDirectEval = false;
  walkAst(program, (node) => {
    for (const name of declarationNames(node)) {
      if (declarationCounts.has(name)) {
        declarationCounts.set(name, declarationCounts.get(name) + 1);
      }
    }
    for (const name of writtenNames(node)) {
      if (declarationCounts.has(name)) written.add(name);
    }
    if (isDirectEvalCall(node)) hasDirectEval = true;
  });
  return { declarationCounts, written, hasDirectEval };
}

function computedImportCandidates(imports) {
  const candidateNames = [];
  for (const importExpression of imports) {
    if (isLiteralImportSource(importExpression.source)) continue;
    const source = unwrappedExpression(importExpression.source);
    if (source.type !== "Identifier") {
      throw contractError("computed dynamic import target is not a provably immutable string binding");
    }
    candidateNames.push(source.name);
  }
  return candidateNames;
}

function replacementForComputedImport(importExpression, stringBindings, safety) {
  const bindingName = unwrappedExpression(importExpression.source).name;
  const binding = stringBindings.get(bindingName);
  if (!binding) {
    throw contractError(`computed dynamic import '${bindingName}' is not initialized by a top-level string literal`);
  }
  if (safety.declarationCounts.get(bindingName) !== 1) {
    throw contractError(`computed dynamic import binding '${bindingName}' is duplicated or shadowed`);
  }
  if (safety.written.has(bindingName)) {
    throw contractError(`computed dynamic import binding '${bindingName}' is mutable`);
  }
  if (importExpression.source.start < binding.initializedAt) {
    throw contractError(`computed dynamic import binding '${bindingName}' is referenced before its string initializer`);
  }
  return {
    start: importExpression.source.start,
    end: importExpression.source.end,
    text: JSON.stringify(binding.specifier),
  };
}

function literalImportReplacements(imports) {
  return imports.flatMap((importExpression) => {
    const literalSpecifier = literalImportSpecifier(importExpression.source);
    if (literalSpecifier === null || importExpression.source.type === "Literal") return [];
    return [{
      start: importExpression.source.start,
      end: importExpression.source.end,
      text: JSON.stringify(literalSpecifier),
    }];
  });
}

function validatedReplacements(program, imports) {
  const candidateNames = computedImportCandidates(imports);
  const literalReplacements = literalImportReplacements(imports);
  if (candidateNames.length === 0) return literalReplacements;
  const stringBindings = topLevelStringBindings(program);
  const uniqueNames = [...new Set(candidateNames)];
  const safety = bindingSafety(program, uniqueNames);
  if (safety.hasDirectEval) {
    throw contractError("direct eval prevents proving computed import targets are immutable");
  }
  const computedReplacements = imports
    .filter((importExpression) => !isLiteralImportSource(importExpression.source))
    .map((importExpression) => replacementForComputedImport(importExpression, stringBindings, safety));
  return [...literalReplacements, ...computedReplacements];
}

function parsedModule(source) {
  try {
    return parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowHashBang: true,
      allowAwaitOutsideFunction: true,
      preserveParens: true,
    });
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw contractError(`JavaScript parsing failed: ${error.message}`);
  }
}

export function normalizeEdgeFunctionBundle(source) {
  const program = parsedModule(source);
  const replacements = validatedReplacements(program, importExpressions(program));
  let normalized = source;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    normalized = normalized.slice(0, replacement.start) + replacement.text + normalized.slice(replacement.end);
  }
  return normalized;
}
