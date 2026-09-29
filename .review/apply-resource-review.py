from pathlib import Path
import subprocess

source = Path('packages/compiler/src/analyze.ts')
expected = 'f090c428bf32a08d4948abc001188994537f3af5'
actual = subprocess.check_output(['git', 'hash-object', str(source)], text=True).strip()
if actual != expected:
    raise SystemExit(f'Refusing to patch unexpected analyzer blob: {actual}')
text = source.read_text()

def replace(old, new, count=1):
    global text
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f'Expected {count} occurrences, found {actual}: {old[:100]}')
    text = text.replace(old, new)

replace('/** Declared infrastructure resources keyed by class name. */\n  infraResources: Map<string, InfraResourceNode>;\n  /** Logical resource name -> declaring class name, for duplicate detection and lookups. */\n  infraResourceClasses: Map<string, string>;',
        '/** Declared infrastructure resources keyed by declaration identity. */\n  infraResources: Map<ClassDeclaration, InfraResourceNode>;\n  /** Logical resource name -> actual declaration, for duplicate detection and lookups. */\n  infraResourceClasses: Map<string, ClassDeclaration>;')
replace('ctx.infraResourceClasses.get(resource) ?? resource', 'ctx.infraResourceClasses.get(resource)?.name?.text ?? resource')
replace('getProp(meta, "uses")', 'infraResourceProp(meta, "uses", ctx)', count=3)
replace('''  const moduleResourceNames = new Set<string>();
  for (const el of arrayProp(options, "resources")) {
    const resource = resolveInfraResourceRef(el, ctx, `module ${name}`, sourcePath(ctx.rootDir, file), lineOf(el));
    if (resource) moduleResourceNames.add(resource);
  }''', '''  const moduleResourceNames = parseModuleInfraResources(
    infraResourceProp(options, "resources", ctx), ctx, `module ${name}`, sourcePath(ctx.rootDir, file), line,
  );''')
replace('''  const standaloneCommands: CommandNode[] = [];

  for (const [name, classInfo]''', '''  const standaloneCommands: CommandNode[] = [];
  const standaloneResourceNames = new Set(modules.find((module) => module.name === "root" || module.name === "app")?.resources ?? []);

  for (const [name, classInfo]''')
replace('''          standaloneCommands.push({''', '''          rejectUndeclaredResourceUses(standaloneUses, standaloneResourceNames, ctx,
            `command ${standaloneName}`, sourcePath(ctx.rootDir, classInfo.file), lineOf(classInfo.decl));
          standaloneCommands.push({''')
replace('''  resourceUses.sort((left, right) =>
    `${left.module}:${left.command ?? left.job ?? ""}:${left.resource}`
      .localeCompare(`${right.module}:${right.command ?? right.job ?? ""}:${right.resource}`, "en"),
  );''', '''  resourceUses.sort((left, right) =>
    left.module.localeCompare(right.module, "en")
    || (left.command ?? left.job ?? "").localeCompare(right.command ?? right.job ?? "", "en")
    || (left.command === undefined ? "job" : "command").localeCompare(right.command === undefined ? "job" : "command", "en")
    || left.resource.localeCompare(right.resource, "en"),
  );''')
start = text.index('function indexInfraResource(')
end = text.index('\nfunction warn(', start)
text = text[:start] + Path('.review/resource-block.ts').read_text() + text[end:]
replace('''  const declaration = identifier ? resolveDeclaration(identifier, ctx).find(ts.isClassDeclaration) : undefined;''', '''  let symbol = identifier ? ctx.checker.getSymbolAtLocation(identifier) : undefined;
  const visited = new Set<TsSymbol>();
  while (symbol && (symbol.flags & ts.SymbolFlags.Alias) && !visited.has(symbol)) {
    visited.add(symbol);
    symbol = ctx.checker.getAliasedSymbol(symbol);
  }
  const declaration = symbol?.declarations?.find(ts.isClassDeclaration);''')
source.write_text(text)

doc = Path('docs/application-resource-model.md')
text = doc.read_text()
text = text.replace('uses: [{ resource: AttachmentsBucket, operations: ["publish"] }]', 'uses: [{ resource: AttachmentsBucket, operations: ["write"] }]')
text = text.replace('''`operations` is one or more of `read | write | publish | consume`; when omitted
it defaults to `read`. A command or job may only use resources its module
declared.''', '''`operations` is a nonempty static array of string literals from
`read | write | publish | consume`. **Only omitting the property** defaults to
`read`; `[]`, `null`, explicit `undefined`, scalar values, spreads and dynamic
expressions are compilation errors, never an implicit read. `resources` and
`uses` must also be static arrays; empty arrays are allowed for these two fields.
Syntax-only wrappers such as parentheses and `as const` are accepted. Unsupported
shorthand, computed or spread properties are errors when explicitly declaring
resources or uses, not silently omitted relationships.

Resource references resolve by their actual class declarations, including import
aliases, re-exports and namespace imports. Unrelated classes with the same name
cannot share or overwrite resource metadata. Repeated uses of the same resource
are merged; operations use canonical `read`, `write`, `publish`, `consume` order.

A command or job may only use resources its module declared. An automatically
registered standalone command follows the same rule for the existing `root` or
`app` module. A synthetic root grants no implicit resource declarations: declare
the resource in an explicit root/app module, or register the command in a module
that declares it. The operation vocabulary is descriptive; it does not prove
resource-kind capabilities or runtime authorization.''')
text = text.replace('''- **Explicit references only.** Only explicit `@InfraResource` classes referenced
  from `resources`/`uses` are analyzed. Dynamic SQL, arbitrary `fetch` and''', '''- **Explicit declarations and references only.** All explicit `@InfraResource`
  declarations in the analyzed project are indexed, including unused declarations
  for duplicate-name diagnostics. `resources`/`uses` resolve actual declarations.
  Dynamic SQL, arbitrary `fetch` and''')
text = text.replace('An operation is not `read \\| write \\| publish \\| consume`', 'Operations are not a nonempty static array of supported string literals')
doc.write_text(text.rstrip() + '\n')
