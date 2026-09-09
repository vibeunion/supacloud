import type { ContractDecoder } from "./http_contract";

export type CommandJson = null | boolean | number | string | CommandJson[] | { [key: string]: CommandJson };

export function decodeCommandJson(value: unknown): CommandJson {
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): CommandJson => {
    if (depth > 100) throw new TypeError("Invalid command JSON");
    if (item === null || typeof item === "boolean" || typeof item === "string") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || item === null || ancestors.has(item)) throw new TypeError("Invalid command JSON");
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return Array.from(item, (entry: unknown) => visit(entry, depth + 1));
      const prototype: unknown = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Invalid command JSON");
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, entry]) => [key, visit(entry, depth + 1)]));
    } finally { ancestors.delete(item); }
  };
  return visit(value, 0);
}

export function canonicalCommandJson(value: unknown): string {
  return JSON.stringify(decodeCommandJson(value));
}

export interface CommandIdentity { tenantId: string; actorId: string }
export interface CommandReference extends CommandIdentity {
  command: string;
  operationId: string;
  dispatchKey: string;
}

export type DurableCommandReceipt<Result> = CommandReference & (
  | { status: "pending"; audit: "pending" }
  | { status: "unknown"; audit: "pending" }
  | { status: "confirmed"; audit: "pending" | "complete"; result: Result }
);

export function commandIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:@|-]{1,200}$/.test(value)) {
    throw new TypeError("Invalid command identifier");
  }
  return value;
}

export function decodeCommandIdentity(value: unknown): CommandIdentity {
  if (!value || typeof value !== "object" || !("tenantId" in value) || !("actorId" in value)) {
    throw new TypeError("Invalid command identity");
  }
  return { tenantId: commandIdentifier(value.tenantId), actorId: commandIdentifier(value.actorId) };
}

export function decodeDurableCommandReceipt<Result>(
  value: unknown, result: ContractDecoder<Result>,
): DurableCommandReceipt<Result> {
  const identity = decodeCommandIdentity(value);
  if (!value || typeof value !== "object" || !("command" in value) || !("operationId" in value)
    || !("dispatchKey" in value) || !("status" in value) || !("audit" in value)) {
    throw new TypeError("Invalid command receipt");
  }
  const reference: CommandReference = {
    ...identity, command: commandIdentifier(value.command),
    operationId: commandIdentifier(value.operationId), dispatchKey: commandIdentifier(value.dispatchKey),
  };
  if (value.status === "confirmed" && (value.audit === "pending" || value.audit === "complete") && "result" in value) {
    return { ...reference, status: "confirmed", audit: value.audit, result: result(value.result) };
  }
  if (value.audit === "pending" && (value.status === "pending" || value.status === "unknown") && !("result" in value)) {
    return { ...reference, status: value.status, audit: "pending" };
  }
  throw new TypeError("Invalid command receipt");
}
