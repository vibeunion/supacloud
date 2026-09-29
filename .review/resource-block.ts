/** Strip syntax-only wrappers; never evaluate arbitrary resource expressions. */
function unwrapInfraResourceExpression(value: Expression): Expression {
  while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value)
    || ts.isTypeAssertionExpression(value) || ts.isSatisfiesExpression(value)
    || ts.isNonNullExpression(value)) {
    value = value.expression;
  }
  return value;
}

/** A present but unsupported declaration must not look like an omitted field. */
function infraResourceProp(obj: ObjectLiteralExpression, name: "resources" | "uses", ctx: AnalysisContext): Expression | undefined {
  const members = obj.properties.filter((member) => member.name && propertyName(member.name) === name);
  if (members.length === 0) return undefined;
  const member = members[0]!;
  if (members.length !== 1 || !ts.isPropertyAssignment(member)
    || ts.isComputedPropertyName(member.name) || obj.properties.some(ts.isSpreadAssignment)) {
    pushResourceError(ctx, "unknown-resource", `${name} 必须是唯一、显式的静态属性，且不能被对象展开覆盖`,
      sourcePath(ctx.rootDir, obj.getSourceFile().fileName), lineOf(member),
      `使用 ${name}: [...]，不要使用简写属性、计算属性或对象展开。`);
    return undefined;
  }
  return member.initializer;
}

function indexInfraResource(cls: ClassDeclaration, className: string, sf: SourceFile, ctx: AnalysisContext): void {
  const decorator = findDecorator(cls, "InfraResource");
  if (!decorator) return;
  const file = sourcePath(ctx.rootDir, sf.fileName);
  const line = lineOf(cls);
  const options = decoratorObjectArg(decorator);
  if (!options || options.properties.some((property) => !ts.isPropertyAssignment(property)
    || ts.isComputedPropertyName(property.name))
    || new Set(options.properties.map((property) => property.name && propertyName(property.name))).size !== options.properties.length) {
    pushResourceError(ctx, "invalid-resource-kind", "@InfraResource 需要静态的 { name, kind } 对象参数", file, line,
      "使用 @InfraResource({ name: \"orders-db\", kind: \"database\" })，不要使用对象展开或重复属性。");
    return;
  }
  const logicalName = stringLiteralProp(options, "name");
  const kindValue = stringLiteralProp(options, "kind");
  if (!logicalName || logicalName.trim().length === 0) {
    pushResourceError(ctx, "invalid-resource-kind", "@InfraResource 缺少非空 name", file, line,
      "为资源提供一个跨环境稳定的非空逻辑名称。");
    return;
  }
  if (!kindValue || !isInfraResourceKind(kindValue)) {
    pushResourceError(ctx, "invalid-resource-kind", `@InfraResource '${logicalName}' 的 kind 无效：${kindValue ?? "<missing>"}`,
      file, line, `kind 必须是 ${INFRA_RESOURCE_KINDS.join(" | ")} 之一。`);
    return;
  }
  const existing = ctx.infraResourceClasses.get(logicalName);
  if (existing && existing !== cls) {
    pushResourceError(ctx, "duplicate-resource", `资源逻辑名 '${logicalName}' 已被 ${existing.name?.text ?? "<anonymous>"} 声明`,
      file, line, "为每个逻辑资源保留一个声明类，或改用不同的 name。");
    return;
  }
  ctx.infraResourceClasses.set(logicalName, cls);
  ctx.infraResources.set(cls, {
    name: logicalName, kind: kindValue, className, file, line,
    importPath: modulePath(ctx.rootDir, sf.fileName),
  });
}

/** Resolve the actual declaration, not a project-global class-name fallback. */
function resolveInfraResourceRef(el: Expression, ctx: AnalysisContext, owner: string, file: string, line: number): string | undefined {
  const unwrapped = unwrapInfraResourceExpression(unwrapForwardRef(unwrapInfraResourceExpression(el)));
  const identifier = ts.isIdentifier(unwrapped) ? unwrapped
    : ts.isPropertyAccessExpression(unwrapped) && ts.isIdentifier(unwrapped.name) ? unwrapped.name : undefined;
  const declaration = identifier ? resolveDeclaration(identifier, ctx).find(ts.isClassDeclaration) : undefined;
  const resource = declaration ? ctx.infraResources.get(declaration) : undefined;
  if (!resource) {
    pushResourceError(ctx, "unknown-resource", `${owner} 引用的资源 '${nodeText(el)}' 未声明为 @InfraResource`,
      file, line, "引用实际声明了 @InfraResource({ name, kind }) 的类，不能依赖其他文件的同名类。");
    return undefined;
  }
  return resource.name;
}

function parseModuleInfraResources(value: Expression | undefined, ctx: AnalysisContext, owner: string, file: string, line: number): Set<string> {
  const names = new Set<string>();
  if (!value) return names;
  const array = unwrapInfraResourceExpression(value);
  if (!ts.isArrayLiteralExpression(array)) {
    pushResourceError(ctx, "unknown-resource", `${owner} 的 resources 必须是静态数组`, file, line,
      "使用 resources: [ResourceClass]；省略该属性表示不声明资源。");
    return names;
  }
  for (const element of array.elements) {
    const resource = resolveInfraResourceRef(element, ctx, owner, file, lineOf(element));
    if (resource) names.add(resource);
  }
  return names;
}

function parseInfraResourceUseRefs(value: Expression | undefined, ctx: AnalysisContext, owner: string, file: string, line: number): InfraResourceUseRef[] {
  if (!value) return [];
  const array = unwrapInfraResourceExpression(value);
  if (!ts.isArrayLiteralExpression(array)) {
    pushResourceError(ctx, "unknown-resource", `${owner} 的 uses 必须是静态数组`, file, line,
      "使用 uses: [{ resource: ResourceClass, operations: [\"read\"] }]。");
    return [];
  }
  const uses = new Map<string, Set<InfraResourceOperation>>();
  for (const element of array.elements) {
    const entry = unwrapInfraResourceExpression(element);
    if (!ts.isObjectLiteralExpression(entry)
      || entry.properties.some((property) => !ts.isPropertyAssignment(property)
        || ts.isComputedPropertyName(property.name)
        || !["resource", "operations"].includes(propertyName(property.name)))
      || new Set(entry.properties.map((property) => property.name && propertyName(property.name))).size !== entry.properties.length) {
      pushResourceError(ctx, "unknown-resource", `${owner} 的 uses 项必须是显式的 { resource, operations } 对象`,
        file, lineOf(element), "使用显式属性，不要使用对象/数组展开、简写、计算属性或重复属性。");
      continue;
    }
    const resourceEl = getProp(entry, "resource");
    if (!resourceEl) {
      pushResourceError(ctx, "unknown-resource", `${owner} 的 uses 项缺少 resource`, file, lineOf(entry),
        "在该 uses 项中显式指定 resource: ResourceClass。");
      continue;
    }
    const resource = resolveInfraResourceRef(resourceEl, ctx, owner, file, lineOf(resourceEl));
    if (!resource) continue;
    const operationsEl = getProp(entry, "operations");
    const operations = new Set<InfraResourceOperation>();
    if (operationsEl === undefined) {
      operations.add("read");
    } else {
      const operationArray = unwrapInfraResourceExpression(operationsEl);
      if (!ts.isArrayLiteralExpression(operationArray) || operationArray.elements.length === 0) {
        pushResourceError(ctx, "invalid-resource-operation", `${owner} 对资源 '${resource}' 的 operations 必须是非空静态数组`,
          file, lineOf(operationsEl), "仅省略 operations 时默认 read；显式填写时必须包含有效操作。");
        continue;
      }
      let invalid = false;
      for (const operationEl of operationArray.elements) {
        const operation = unwrapInfraResourceExpression(operationEl);
        if (!ts.isStringLiteral(operation) || !isInfraResourceOperation(operation.text)) {
          pushResourceError(ctx, "invalid-resource-operation", `${owner} 对资源 '${resource}' 声明了无效操作 '${nodeText(operationEl)}'`,
            file, lineOf(operationEl), `operations 只能包含字符串字面量 ${INFRA_RESOURCE_OPERATIONS.join(" | ")}。`);
          invalid = true;
          continue;
        }
        operations.add(operation.text);
      }
      if (invalid) continue;
    }
    const merged = uses.get(resource) ?? new Set<InfraResourceOperation>();
    for (const operation of operations) merged.add(operation);
    uses.set(resource, merged);
  }
  return [...uses.entries()].sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([resource, operations]) => ({ resource, operations: INFRA_RESOURCE_OPERATIONS.filter((operation) => operations.has(operation)) }));
}

function rejectUndeclaredResourceUses(uses: InfraResourceUseRef[], declared: Set<string>, ctx: AnalysisContext, owner: string, file: string, line: number): void {
  for (const use of uses) {
    if (declared.has(use.resource)) continue;
    pushResourceError(ctx, "undeclared-resource-use", `${owner} 使用了模块未声明的资源 '${use.resource}'`,
      file, line, "在所属 @Module({ resources: [...] }) 中声明该资源；自动注册的 standalone command 同样受 root/app 模块约束。");
  }
}

function pushResourceError(ctx: AnalysisContext, code: string, message: string, file: string, line: number, suggestion: string): void {
  ctx.diagnostics.push({ severity: "error", code, message, file, line, suggestion });
}

