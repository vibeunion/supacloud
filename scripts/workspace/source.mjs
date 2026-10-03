import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { ownerOf, slash } from './model.mjs';

const excluded = new Set(['node_modules', 'dist', '__tests__', '__fixtures__', 'fixtures', 'generated', '.generated']);
export function productionSources(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return excluded.has(entry.name) ? [] : productionSources(path);
    if (!entry.isFile() || !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) || /\.(?:test|spec|d)\.[cm]?[jt]sx?$/.test(entry.name)) return [];
    return [path];
  }).sort();
}

export function importSites(ts, source) {
  const sites = [];
  const visit = (node) => {
    let argument;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) argument = node.moduleSpecifier;
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) argument = node.moduleReference.expression;
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) argument = node.argument.literal;
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
      (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'require' && node.expression.name.text === 'resolve'))) argument = node.arguments[0];
    if (argument) {
      const position = source.getLineAndCharacterOfPosition(argument.getStart(source));
      sites.push({ specifier: ts.isStringLiteralLike(argument) ? argument.text : null, line: position.line + 1, column: position.character + 1 });
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

export function publicSubpath(exports, subpath) {
  if (subpath !== '.' && subpath.slice(2).split('/').some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) return false;
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
  const byName = Object.values(workspace.projects).sort((a, b) => b.packageName.length - a.packageName.length);
  let filesScanned = 0;
  for (const project of Object.values(workspace.projects)) {
    const configPath = resolve(workspace.root, project.root, 'tsconfig.json');
    let compilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true };
    if (existsSync(configPath)) {
      const config = ts.readConfigFile(configPath, ts.sys.readFile);
      if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(workspace.root, project.root));
      // File-list/typecheck diagnostics belong to existing type gates, not this import scanner.
      const errors = parsed.errors.filter((error) => error.code !== 18003 && error.code !== 18002);
      if (errors.length) throw new Error(errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
      compilerOptions = parsed.options;
    }
    for (const absolute of productionSources(resolve(workspace.root, project.root, 'src'))) {
      filesScanned++;
      const file = slash(relative(workspace.root, absolute));
      const source = ts.createSourceFile(absolute, readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, true);
      for (const error of source.parseDiagnostics) {
        const position = source.getLineAndCharacterOfPosition(error.start ?? 0);
        diagnostics.push({ code: 'WS_SOURCE_PARSE', file, line: position.line + 1, column: position.character + 1,
          message: ts.flattenDiagnosticMessageText(error.messageText, '\n') });
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
        let target = named;
        if (!target) {
          const resolved = ts.resolveModuleName(specifier, absolute, compilerOptions, ts.sys).resolvedModule;
          const destination = resolved?.resolvedFileName ?? (specifier.startsWith('.') ? resolve(absolute, '..', specifier) : undefined);
          if (destination) target = ownerOf(workspace, slash(relative(workspace.root, destination)));
        }
        if (!target || target.name === project.name) continue;
        edges.push({ source: project.name, target: target.name, ...detail });
        if (!named) {
          report('WS_PRIVATE_IMPORT', `Cross-project path/alias bypasses ${target.packageName} public exports. Import a declared package entrypoint.`);
        } else {
          const subpath = specifier === target.packageName ? '.' : `.${specifier.slice(target.packageName.length)}`;
          if (!publicSubpath(target.manifest.exports, subpath)) report('WS_PRIVATE_IMPORT', `${specifier} is not an exported package entrypoint.`);
          const declared = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
            .some((field) => Object.hasOwn(project.manifest[field] ?? {}, target.packageName));
          if (!declared) report('WS_UNDECLARED_IMPORT', `${target.packageName} must be declared in package.json; an override alone is not a declaration.`);
        }
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
  return { schemaVersion: 1, scope: 'static JS/TS imports under package src; excludes tests, fixtures and generated directories',
    filesScanned, diagnostics, notes, edges };
}
