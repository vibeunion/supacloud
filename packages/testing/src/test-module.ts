/**
 * Provider-override test container for SupaCloud modules.
 *
 * Accepts structural module metadata (compatible in shape with the ModuleMeta
 * produced by @supacloud/app decorators) without importing any runtime package.
 */

/** Static metadata keys used by @supacloud/app decorators. */
const INJECTABLE_METADATA = "supacloud:injectable";
const INJECT_PARAMS_METADATA = "supacloud:inject-params";
const MODULE_METADATA = "supacloud:module";
type Constructor = Function;

export interface ProviderOverride {
  /** InjectionToken instance or class identifying the provider to replace. */
  token: unknown;
  useValue?: unknown;
  useClass?: Constructor;
  useFactory?: (...deps: unknown[]) => unknown;
}

export interface ModuleMetaLike {
  name: string;
  /** Classes or { provide, useClass|useValue|useFactory|useExisting, deps?, scope? } records. */
  providers: unknown[];
  imports?: Array<Constructor> | ModuleMetaLike[];
  [key: string]: unknown;
}

interface ProviderRecord {
  token: unknown;
  provider: unknown;
  override?: ProviderOverride;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isClass(value: unknown): value is Constructor {
  return typeof value === "function";
}

/** Convert a dotted/snake/kebab token name to camelCase. */
function camelCase(name: string): string {
  const parts = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return parts
    .map((part, index) => {
      const lower = part.toLowerCase();
      return index === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}

/**
 * Stable result-map key for a token: InjectionToken names are camelCased
 * ('case.repository' -> caseRepository, 'CASE_REPOSITORY' -> caseRepository),
 * classes use the class name with a lowercase first letter.
 */
export function tokenKey(token: unknown): string {
  if (isClass(token)) {
    const name = token.name;
    if (!name) {
      throw new Error("tokenKey: anonymous class tokens are not supported");
    }
    return name.charAt(0).toLowerCase() + name.slice(1);
  }
  if (isRecord(token) && typeof token.name === "string") {
    return camelCase(token.name);
  }
  throw new Error("tokenKey: unsupported token (expected an InjectionToken-like object or a class)");
}

function describeToken(token: unknown): string {
  try {
    return tokenKey(token);
  } catch {
    return String(token);
  }
}

/** Merge @Injectable deps with @Inject param tokens into a positional array. */
function classDeps(cls: Constructor): unknown[] {
  const metaValue: unknown = Reflect.get(cls, INJECTABLE_METADATA);
  const meta = isRecord(metaValue) && Array.isArray(metaValue.deps)
    ? metaValue.deps
    : [];
  const paramsValue: unknown = Reflect.get(cls, INJECT_PARAMS_METADATA);
  const params = isRecord(paramsValue) ? paramsValue : undefined;
  const deps: unknown[] = [...meta];
  if (params) {
    for (const [index, token] of Object.entries(params)) {
      deps[Number(index)] = token;
    }
  }
  return deps;
}

/** Explicit deps declared on an object provider, if any. */
function explicitDeps(provider: unknown): unknown[] | undefined {
  if (isRecord(provider) && Array.isArray(provider.deps)) {
    return provider.deps;
  }
  return undefined;
}

/** Deps used to construct an override, falling back to the original declaration. */
function overrideDeps(record: ProviderRecord, overrideClass?: Constructor): unknown[] {
  if (overrideClass) {
    const own = classDeps(overrideClass);
    if (own.length > 0) return own;
  }
  const explicit = explicitDeps(record.provider);
  if (explicit) return explicit;
  if (isClass(record.provider)) return classDeps(record.provider);
  if (isRecord(record.provider) && isClass(record.provider.useClass)) {
    return classDeps(record.provider.useClass);
  }
  return [];
}

function collectProviders(meta: ModuleMetaLike, records: ProviderRecord[]): void {
  for (const imported of meta.imports ?? []) {
    if (isClass(imported)) {
      const metadata: unknown = Reflect.get(imported, MODULE_METADATA);
      const importedMeta = isModuleMetaLike(metadata) ? metadata : undefined;
      if (importedMeta) collectProviders(importedMeta, records);
    } else if (isRecord(imported)) {
      if (isModuleMetaLike(imported)) collectProviders(imported, records);
    }
  }
  for (const provider of meta.providers ?? []) {
    const token = isClass(provider)
      ? provider
      : isRecord(provider) && "provide" in provider
        ? provider.provide
        : undefined;
    if (token === undefined) {
      throw new Error(`createTestModule: unrecognized provider in module "${meta.name}"`);
    }
    records.push({ token, provider });
  }
}

/**
 * Instantiate a module with a lightweight container: deps are resolved
 * recursively in provider declaration order and every override whose token
 * matches (===) replaces the original provider. Circular dependencies throw
 * with the dependency ring path.
 *
 * Only application-level instantiation is supported; request/job scoped
 * providers should be re-created by the caller with a context object.
 */
export function createTestModule(
  meta: ModuleMetaLike,
  overrides: ProviderOverride[] = [],
): Record<string, unknown> {
  const records: ProviderRecord[] = [];
  collectProviders(meta, records);

  // Later declarations win on token collision (own providers override imports).
  const byToken = new Map<unknown, ProviderRecord>();
  for (const record of records) {
    byToken.set(record.token, record);
  }

  for (const override of overrides) {
    const existing = byToken.get(override.token);
    if (existing) {
      existing.override = override;
    } else {
      // Override for a token the module does not declare: register it anyway.
      byToken.set(override.token, { token: override.token, provider: undefined, override });
    }
  }

  const instances = new Map<unknown, unknown>();
  const resolving: unknown[] = [];

  const resolve = (token: unknown): unknown => {
    if (instances.has(token)) return instances.get(token);
    const record = byToken.get(token);
    if (!record) {
      throw new Error(`createTestModule: no provider registered for token "${describeToken(token)}"`);
    }
    const cycleStart = resolving.indexOf(token);
    if (cycleStart !== -1) {
      const ring = [...resolving.slice(cycleStart), token].map(describeToken).join(" -> ");
      throw new Error(`createTestModule: circular dependency detected: ${ring}`);
    }
    resolving.push(token);
    try {
      const instance = instantiate(record, resolve);
      instances.set(token, instance);
      return instance;
    } finally {
      resolving.pop();
    }
  };

  for (const token of byToken.keys()) {
    resolve(token);
  }

  const result: Record<string, unknown> = {};
  for (const [token, instance] of instances) {
    result[tokenKey(token)] = instance;
  }
  return result;
}

function instantiate(
  record: ProviderRecord,
  resolve: (token: unknown) => unknown,
): unknown {
  const { provider, override } = record;

  if (override) {
    if ("useValue" in override) return override.useValue;
    if (override.useClass) {
      const deps = overrideDeps(record, override.useClass).map(resolve);
      return Reflect.construct(override.useClass, deps);
    }
    if (override.useFactory) {
      return Reflect.apply(override.useFactory, undefined, overrideDeps(record).map(resolve));
    }
    throw new Error(`createTestModule: override for "${describeToken(record.token)}" has no use* value`);
  }

  // Bare class provider: the class is its own token.
  if (isClass(provider)) {
    return Reflect.construct(provider, classDeps(provider).map(resolve));
  }
  if (!isRecord(provider)) {
    throw new Error(`createTestModule: invalid provider for "${describeToken(record.token)}"`);
  }
  if ("useValue" in provider) return provider.useValue;
  if (isClass(provider.useClass)) {
    const deps = (explicitDeps(provider) ?? classDeps(provider.useClass)).map(resolve);
    return Reflect.construct(provider.useClass, deps);
  }
  if (typeof provider.useFactory === "function") {
    const deps = (explicitDeps(provider) ?? []).map(resolve);
    return Reflect.apply(provider.useFactory, undefined, deps);
  }
  if ("useExisting" in provider) {
    return resolve(provider.useExisting);
  }
  throw new Error(`createTestModule: invalid provider for "${describeToken(record.token)}"`);
}

function isModuleMetaLike(value: unknown): value is ModuleMetaLike {
  return isRecord(value)
    && typeof value.name === "string"
    && Array.isArray(value.providers);
}
