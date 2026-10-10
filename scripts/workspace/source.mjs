import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { ownerOf, slash } from './model.mjs';

const excluded = new Set(['node_modules', 'dist', '__tests__', '__fixtures__', 'fixtures', 'generated', '.generated']);
export function productionSources(directory, onSymlink = () => {}) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return excluded.has(entry.name) ? [] : productionSources(path, onSymlink);
    if (entry.isSymbolicLink()) onSymlink(path);
    if (!entry.isFile() || !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) || /\.(?:test|spec|test-fixtures)\.[cm]?[jt]sx?$/.test(entry.name)) return [];
    return [path];
  }).sort();
}

export function importSites(ts, source) {
  const sites = [];
  const requireFactories = new Set();
  const requireNames = new Set(['require']);
  const printer = ts.createPrinter({ removeComments: true });
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ['node:module', 'module'].includes(statement.moduleSpecifier.text)) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
        if ((binding.propertyName ?? binding.name).text === 'createRequire') requireFactories.add(binding.name.text);
      }
    }
  }
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
        ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) &&
        requireFactories.has(node.initializer.expression.text)) requireNames.add(node.name.text);
    ts.forEachChild(node, collect);
  };
  collect(source);
  const visit = (node) => {
    let argument;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) argument = node.moduleSpecifier;
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) argument = node.moduleReference.expression;
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) argument = node.argument.literal;
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && requireNames.has(node.expression.text)) ||
      (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'resolve' &&
        ((ts.isIdentifier(node.expression.expression) && requireNames.has(node.expression.expression.text)) ||
          (ts.isMetaProperty(node.expression.expression) && node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword))))) argument = node.arguments[0];
    if (argument) {
      const position = source.getLineAndCharacterOfPosition(argument.getStart(source));
      sites.push({ specifier: ts.isStringLiteralLike(argument) ? argument.text : null,
        line: position.line + 1, column: position.character + 1,
        fingerprint: createHash('sha256').update(printer.printNode(ts.EmitHint.Unspecified, node, source)).digest('hex') });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

const EFFECT_RUNTIME_METHODS = new Set(['runPromise', 'runPromiseExit', 'runSync', 'runFork']);
const EFFECT_MODULES = new Set(['effect', 'effect/Effect', 'effect/Runtime']);

/** Finds direct Effect interpretation calls without evaluating application code. */
export function effectRuntimeExecutionSites(ts, source) {
  const namespaceBindings = new Set();
  const runtimeBindings = new Map();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!EFFECT_MODULES.has(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) namespaceBindings.add(clause.name.text);
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      namespaceBindings.add(clause.namedBindings.name.text);
    } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (statement.moduleSpecifier.text === 'effect' && (imported === 'Effect' || imported === 'Runtime')) {
          namespaceBindings.add(element.name.text);
        }
        if (EFFECT_RUNTIME_METHODS.has(imported)) runtimeBindings.set(element.name.text, imported);
      }
    }
  }
  if (namespaceBindings.size === 0 && runtimeBindings.size === 0) return [];
  const sites = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      let method;
      if (ts.isPropertyAccessExpression(node.expression)
        && namespaceBindings.has(node.expression.expression.getText(source))
        && EFFECT_RUNTIME_METHODS.has(node.expression.name.text)) {
        method = node.expression.name.text;
      } else if (ts.isIdentifier(node.expression) && runtimeBindings.has(node.expression.text)) {
        method = runtimeBindings.get(node.expression.text);
      }
      if (method) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        sites.push({ method, line: position.line + 1, column: position.character + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

function enabledExport(value) {
  if (typeof value === 'string') return true;
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(enabledExport);
}

/** Declared-public-entrypoint policy, not a complete Node resolution emulator. */
export function publicSubpath(exports, subpath) {
  if (subpath !== '.' && (!subpath.startsWith('./') || subpath.slice(2).split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\\') || /%2e|%2f|%5c/i.test(part)))) return false;
  if (exports === undefined) return subpath === '.';
  if (!exports || typeof exports !== 'object' || Array.isArray(exports)) return subpath === '.' && enabledExport(exports);
  if (!Object.keys(exports).some((key) => key.startsWith('.'))) return subpath === '.' && enabledExport(exports);
  if (Object.hasOwn(exports, subpath)) return enabledExport(exports[subpath]);
  const patterns = Object.keys(exports).filter((key) => key.includes('*')).sort((a, b) =>
    b.indexOf('*') - a.indexOf('*') || b.length - a.length);
  for (const key of patterns) {
    const [prefix, suffix] = key.split('*');
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length) return enabledExport(exports[key]);
  }
  return false;
}

/** Reuses the existing tag policy; does not infer runtime behavior from imports. */
export function checkSourceBoundaries(workspace, ts, rules) {
  const diagnostics = [];
  const notes = [];
  const edges = [];
  const normalize = (message) => slash(message).replaceAll(slash(workspace.root), '<workspace>');
  const byName = Object.values(workspace.projects).sort((a, b) => b.packageName.length - a.packageName.length);
  let filesScanned = 0;
  for (const project of Object.values(workspace.projects)) {
    const configPath = resolve(workspace.root, project.root, 'tsconfig.json');
    let compilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true };
    if (existsSync(configPath)) {
      const config = ts.readConfigFile(configPath, ts.sys.readFile);
      if (config.error) {
        diagnostics.push({ code: 'WS_TSCONFIG', file: `${project.root}/tsconfig.json`, line: 1, column: 1,
          tsCode: config.error.code, message: normalize(ts.flattenDiagnosticMessageText(config.error.messageText, '\n')) });
      } else {
        const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(workspace.root, project.root));
        // Missing generated extends still permit named/relative checks, but never a clean result.
        const errors = parsed.errors.filter((error) => error.code !== 18003 && error.code !== 18002);
        for (const error of errors) diagnostics.push({ code: 'WS_TSCONFIG', file: `${project.root}/tsconfig.json`,
          line: 1, column: 1, tsCode: error.code, message: normalize(ts.flattenDiagnosticMessageText(error.messageText, '\n')) });
        compilerOptions = parsed.options;
      }
    }
    for (const absolute of productionSources(resolve(workspace.root, project.root, 'src'), (path) => notes.push({
      code: 'WS_SOURCE_SYMLINK', file: slash(relative(workspace.root, path)), line: 1, column: 1,
      message: 'Symlinked source is not scanned; coverage requires an explicit owned source file.' }))) {
      filesScanned++;
      const file = slash(relative(workspace.root, absolute));
      const source = ts.createSourceFile(absolute, readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, true);
      for (const error of source.parseDiagnostics) {
        const position = source.getLineAndCharacterOfPosition(error.start ?? 0);
        diagnostics.push({ code: 'WS_SOURCE_PARSE', file, line: position.line + 1, column: position.character + 1,
          message: ts.flattenDiagnosticMessageText(error.messageText, '\n') });
      }
      for (const site of effectRuntimeExecutionSites(ts, source)) {
        if (file === 'packages/elysia/src/effect.ts') continue;
        diagnostics.push({
          code: 'WS_EFFECT_RUNTIME_ESCAPE',
          file,
          ...site,
          message: `Direct Effect.${site.method} execution escapes the framework adapter boundary.`,
        });
      }
      for (const site of importSites(ts, source)) {
        const detail = { file, ...site };
        const report = (code, message) => diagnostics.push({ code, ...detail, message });
        if (site.specifier === null) {
          notes.push({ code: 'WS_DYNAMIC_IMPORT', ...detail, message: 'Computed module reference is not statically checked.' });
          continue;
        }
        const specifier = site.specifier;
        const named = byName.find((target) => specifier === target.packageName || specifier.startsWith(`${target.packageName}/`));
        // Resolve even a declared/self package name: tsconfig paths may redirect it.
        const resolved = ts.resolveModuleName(specifier, absolute, compilerOptions, ts.sys).resolvedModule;
        const destination = resolved?.resolvedFileName ?? (specifier.startsWith('.') ? resolve(absolute, '..', specifier) : undefined);
        const destinationPath = destination ? slash(destination) : '';
        const installedAt = destinationPath.lastIndexOf('/node_modules/');
        const installedName = installedAt < 0 ? undefined : destinationPath.slice(installedAt + '/node_modules/'.length);
        const actual = installedName !== undefined
          ? byName.find((candidate) => installedName === candidate.packageName || installedName.startsWith(`${candidate.packageName}/`))
          : destination ? ownerOf(workspace, slash(relative(workspace.root, destination))) : undefined;
        const matchesAlias = Object.keys(compilerOptions.paths ?? {}).some((pattern) => {
          const star = pattern.indexOf('*');
          return star < 0 ? pattern === specifier : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1));
        });
        if (matchesAlias && !resolved) notes.push({ code: 'WS_UNRESOLVED_ALIAS', ...detail,
          message: 'Configured alias has no resolvable target; its source dependency is unverified.' });
        const target = actual ?? named;
        if (!target) continue;
        const crossProject = target.name !== project.name;
        if (crossProject) edges.push({ source: project.name, target: target.name, ...detail });
        const bypass = crossProject && (!named || actual && actual.name !== named.name || matchesAlias);
        if (bypass) report('WS_PRIVATE_IMPORT', `Cross-project path/alias bypasses ${target.packageName} public exports. Import a declared package entrypoint.`);
        else if (named) {
          const subpath = specifier === named.packageName ? '.' : `.${specifier.slice(named.packageName.length)}`;
          if (!publicSubpath(named.manifest.exports, subpath)) report('WS_PRIVATE_IMPORT', `${specifier} is not a declared public package entrypoint.`);
        }
        if (!crossProject) continue;
        const declared = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
          .some((field) => Object.hasOwn(project.manifest[field] ?? {}, target.packageName));
        if (!declared) report('WS_UNDECLARED_IMPORT', `${target.packageName} must be declared in package.json; an override alone is not a declaration.`);
        for (const rule of rules) {
          if (rule.sourceTag !== '*' && !project.tags.includes(rule.sourceTag)) continue;
          if (rule.bannedDependenciesWithTags?.some((tag) => target.tags.includes(tag)) ||
            (rule.onlyDependOnLibsWithTags?.length && !rule.onlyDependOnLibsWithTags.some((tag) => target.tags.includes(tag)))) {
            report('WS_BOUNDARY_VIOLATION', rule.description ?? `${project.name} may not import ${target.name}.`);
          }
        }
      }
    }
  }
  for (const finding of [...diagnostics, ...notes]) finding.fingerprint ??= createHash('sha256')
    .update(JSON.stringify([finding.code, finding.file, finding.tsCode ?? null, finding.message])).digest('hex');
  return { schemaVersion: 1, scope: 'static JS/TS imports under package src; excludes tests, fixtures and generated directories',
    filesScanned, diagnostics, notes, edges };
}
