/**
 * Source contract for named database RPC capabilities.
 *
 * The database package does not decide whether a capability is a Command or a
 * legacy bridge. It only verifies that every named capability can be traced to
 * a maintained registry/catalog entry or an explicitly recorded historical
 * entry. The artifact formats intentionally accept both the generated
 * `definitions` catalog shape and a registry array of `{ name }` records.
 */

export interface RpcBoundaryCheckOptions {
  readonly capabilities: readonly string[];
  readonly registry?: unknown;
  readonly catalog?: unknown;
  readonly legacy?: unknown;
}

export interface RpcBoundaryReport {
  readonly ok: boolean;
  readonly capabilities: readonly string[];
  readonly sourced: readonly string[];
  readonly historical: readonly string[];
  readonly missing: readonly string[];
  readonly sourceCount: number;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function capabilityName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw new TypeError("RPC capability names must be nonempty identifiers");
  }
  return value;
}

function addName(names: Set<string>, value: unknown): void {
  if (typeof value !== "string" || value.trim() === "") return;
  const name = value.trim().replace(/\s*\(.*$/, "");
  if (!name) return;
  names.add(name);
  const separator = name.lastIndexOf(".");
  if (separator > -1 && separator < name.length - 1) names.add(name.slice(separator + 1));
}

function entries(value: unknown, label: string): readonly unknown[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (!record(value)) throw new TypeError(`Invalid ${label} RPC artifact`);
  for (const key of ["entries", "definitions", "functions", "rpcs", "names", "capabilities"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
  }
  if (Array.isArray(value["legacyRpcNames"])) return value["legacyRpcNames"] as readonly unknown[];
  throw new TypeError(`Invalid ${label} RPC artifact entries`);
}

function artifactNames(value: unknown, label: string): Set<string> {
  const names = new Set<string>();
  for (const entry of entries(value, label)) {
    if (typeof entry === "string") {
      addName(names, entry);
      continue;
    }
    if (!record(entry)) throw new TypeError(`Invalid ${label} RPC artifact entry`);
    for (const key of ["name", "identity", "rpc", "command", "capability"]) {
      addName(names, entry[key]);
    }
  }
  return names;
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/** Verify that named Command capabilities have a governed RPC source. */
export function checkRpcBoundary(options: RpcBoundaryCheckOptions): RpcBoundaryReport {
  if (!Array.isArray(options.capabilities)) throw new TypeError("RPC capabilities must be an array");
  const capabilities = sorted(options.capabilities.map(capabilityName));
  const registry = artifactNames(options.registry, "registry");
  const catalog = artifactNames(options.catalog, "catalog");
  const historical = artifactNames(options.legacy, "legacy");
  const sourcedNames = new Set([...registry, ...catalog]);
  const sourced = capabilities.filter(name => sourcedNames.has(name));
  const historicalCapabilities = capabilities.filter(name => !sourcedNames.has(name) && historical.has(name));
  const missing = capabilities.filter(name => !sourcedNames.has(name) && !historical.has(name));
  return {
    ok: missing.length === 0,
    capabilities,
    sourced,
    historical: historicalCapabilities,
    missing,
    sourceCount: sourcedNames.size,
  };
}
