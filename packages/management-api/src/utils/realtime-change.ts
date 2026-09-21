import { isRecord } from "./project-config";
import { canEvaluateRealtimeFilterNatively, decodeRealtimeQuotedScalar, parseRealtimeFilter } from "./realtime-filter-contract";

export type ChangeType = "INSERT" | "UPDATE" | "DELETE";

export interface PostgresChangeConfig {
  id?: string | number;
  event: ChangeType | "*";
  schema: string;
  table?: string;
  filter?: string;
  select?: string[];
}

export interface RealtimeChange {
  columns: Array<{ name: string; type: string }>;
  commit_timestamp: string;
  record: Record<string, unknown>;
  old_record?: Record<string, unknown>;
  schema: string;
  table: string;
  type: ChangeType;
}

export interface ChangeEvent {
    data: RealtimeChange & { errors: string[] };
    ids: Array<string | number>;
}

function changeType(value: unknown): value is ChangeType {
  return value === "INSERT" || value === "UPDATE" || value === "DELETE";
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isRealtimeIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(value);
}

function isRealtimePattern(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && Buffer.byteLength(value) <= 63;
}

export function parsePostgresChangeSubscriptions(value: unknown): PostgresChangeConfig[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return null;
  const result: PostgresChangeConfig[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || (entry.event !== "*" && !changeType(entry.event))
      || !isRealtimePattern(entry.schema)) return null;
    const { id } = entry;
    const table = entry.table === null || entry.table === "" ? undefined : entry.table;
    const filter = entry.filter === null || entry.filter === "" ? undefined : entry.filter;
    if (id !== undefined && !nonemptyString(id)
      && !(typeof id === "number" && Number.isSafeInteger(id) && id >= 0)) return null;
    if (table !== undefined && !isRealtimePattern(table)) return null;
    if (filter !== undefined && (typeof filter !== "string" || !parseRealtimeFilter(filter))) return null;
    let select: string[] | undefined;
    if (entry.select !== undefined) {
      if (!Array.isArray(entry.select) || entry.select.length > 100) return null;
      select = [];
      for (const column of entry.select) {
        if (!isRealtimePattern(column)) return null;
        select.push(column);
      }
      if (new Set(select).size !== select.length) return null;
    }
    result.push({
      event: entry.event, schema: entry.schema,
      ...(id === undefined ? {} : { id }),
      ...(table === undefined ? {} : { table }),
      ...(filter === undefined ? {} : { filter }),
      ...(select === undefined ? {} : { select }),
    });
  }
  return result;
}

export function canUseNativeRealtimeSubscriptions(subscriptions: PostgresChangeConfig[]): boolean {
  return subscriptions.every((subscription) => isRealtimeIdentifier(subscription.schema)
    && isRealtimeIdentifier(subscription.table) && canEvaluateRealtimeFilterNatively(subscription.filter)
    && (subscription.select === undefined || subscription.select.every(isRealtimeIdentifier)));
}

export function sameRealtimeSubscription(left: PostgresChangeConfig, right: PostgresChangeConfig): boolean {
  return left.event === right.event && left.schema === right.schema
    && left.table === right.table && left.filter === right.filter
    && (right.select === undefined || JSON.stringify(left.select) === JSON.stringify(right.select));
}

export function bindRealtimeSubscriptionIds(
  subscriptions: PostgresChangeConfig[], value: unknown,
): PostgresChangeConfig[] | null {
  const mappings = parsePostgresChangeSubscriptions(value);
  if (!mappings || mappings.length !== subscriptions.length) return null;
  const bound: PostgresChangeConfig[] = [];
  const identities = new Map<string | number, string>();
  for (const [index, subscription] of subscriptions.entries()) {
    const mapping = mappings[index];
    if (!mapping || mapping.id === undefined || !sameRealtimeSubscription(subscription, mapping)) return null;
    const identity = JSON.stringify({ ...subscription, id: null });
    const previous = identities.get(mapping.id);
    if (previous !== undefined && previous !== identity) return null;
    identities.set(mapping.id, identity);
    bound.push({ ...subscription, id: mapping.id });
  }
  return bound;
}

export function projectRealtimeChangeEvents(
  event: ChangeEvent, subscriptions: PostgresChangeConfig[],
): ChangeEvent[] {
  const groups = new Map<string, { ids: Array<string | number>; select?: string[] }>();
  for (const [index, subscription] of subscriptions.entries()) {
    const id = subscription.id ?? String(index);
    if (!event.ids.includes(id)) continue;
    const key = JSON.stringify(subscription.select === undefined ? null : [...subscription.select].sort());
    let group = groups.get(key);
    if (!group) {
      group = { ids: [], ...(subscription.select === undefined ? {} : { select: subscription.select }) };
      groups.set(key, group);
    }
    if (!group.ids.includes(id)) group.ids.push(id);
  }
  return [...groups.values()].map(({ ids, select }) => {
    if (select === undefined || select.includes("*")) return { ...event, ids };
    const selected = new Set(select);
    const project = (record: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(record).filter(([name]) => selected.has(name)));
    return {
      ids, data: {
        ...event.data, record: project(event.data.record),
        columns: event.data.columns.filter((column) => selected.has(column.name)),
        ...(event.data.old_record === undefined ? {} : { old_record: project(event.data.old_record) }),
      },
    };
  });
}

export function parseRealtimeChange(raw: unknown): RealtimeChange | null {
  if (!isRecord(raw)) return null;
  const inner = "payload" in raw ? raw.payload : raw;
  if (!isRecord(inner)) return null;
  const type = inner.type ?? inner.event;
  const schema = inner.schema ?? "public";
  if (!changeType(type) || !nonemptyString(schema) || !nonemptyString(inner.table)) return null;
  const newValue = inner.record ?? inner.new;
  const oldValue = inner.old_record ?? inner.old;
  if (type !== "DELETE" && !isRecord(newValue)) return null;
  if (type === "DELETE" && !isRecord(oldValue)) return null;
  if (newValue != null && !isRecord(newValue)) return null;
  if (oldValue != null && !isRecord(oldValue)) return null;
  const record = isRecord(newValue) ? { ...newValue } : {};
  const oldRecord = isRecord(oldValue) ? { ...oldValue } : undefined;
  const timestamp = inner.commit_timestamp ?? new Date().toISOString();
  if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) return null;

  const columns: RealtimeChange["columns"] = [];
  if (Array.isArray(inner.columns)) {
    for (const column of inner.columns) {
      if (!isRecord(column) || !nonemptyString(column.name) || !nonemptyString(column.type)) return null;
      columns.push({ name: column.name, type: column.type });
    }
  } else {
    if (inner.columns !== undefined && !isRecord(inner.columns)) return null;
    for (const [name, value] of Object.entries(record)) {
      const type = isRecord(inner.columns) ? inner.columns[name] : undefined;
      if (type !== undefined && !nonemptyString(type)) return null;
      columns.push({ name, type: type ?? (typeof value === "number" ? "numeric" : "text") });
    }
  }
  return {
    type, schema, table: inner.table, record, columns, commit_timestamp: timestamp,
    ...(oldRecord === undefined ? {} : { old_record: oldRecord }),
  };
}

function walRecord(names: unknown, values: unknown): Record<string, unknown> | null {
  if (!Array.isArray(names) || !Array.isArray(values) || names.length !== values.length) return null;
  const entries: [string, unknown][] = [];
  const seen = new Set<string>();
  for (const [index, name] of names.entries()) {
    if (!nonemptyString(name) || seen.has(name) || !(index in values)) return null;
    seen.add(name);
    entries.push([name, values[index]]);
  }
  return Object.fromEntries(entries);
}

export function parseWalChanges(value: unknown): RealtimeChange[] | null {
  if (!isRecord(value) || !Array.isArray(value.change)) return null;
  const changes: RealtimeChange[] = [];
  for (const entry of value.change) {
    if (!isRecord(entry)) return null;
    const type = entry.kind === "insert" ? "INSERT" : entry.kind === "update" ? "UPDATE"
      : entry.kind === "delete" ? "DELETE" : undefined;
    if (!type) return null;
    const record = type === "DELETE" ? {} : walRecord(entry.columnnames, entry.columnvalues);
    const oldRecord = entry.oldkeys === undefined ? undefined
      : isRecord(entry.oldkeys) ? walRecord(entry.oldkeys.keynames, entry.oldkeys.keyvalues) : null;
    if (!record || oldRecord === null || (type === "DELETE" && !oldRecord)) return null;
    const columns: RealtimeChange["columns"] = [];
    if (entry.columntypes !== undefined) {
      if (!Array.isArray(entry.columntypes) || !Array.isArray(entry.columnnames)
        || entry.columntypes.length !== entry.columnnames.length) return null;
      for (const [index, name] of entry.columnnames.entries()) {
        const columnType: unknown = entry.columntypes[index];
        if (!nonemptyString(name) || !nonemptyString(columnType)) return null;
        columns.push({ name, type: columnType });
      }
    }
    const change = parseRealtimeChange({
      type, schema: entry.schema, table: entry.table, record,
      ...(oldRecord === undefined ? {} : { old_record: oldRecord }),
      ...(entry.columntypes === undefined ? {} : { columns }),
      ...(value.timestamp === undefined ? {} : { commit_timestamp: value.timestamp }),
    });
    if (!change) return null;
    changes.push(change);
  }
  return changes;
}

type FilterOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike" | "in";

function isFilterOperator(value: string): value is FilterOperator {
  return ["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "in"].includes(value);
}

function parseFilter(filter: string): { column: string; operator: FilterOperator; value: string } | null {
  if (filter.length > 512) return null;
  const equal = filter.indexOf("=");
  if (equal <= 0) return null;
  const column = filter.slice(0, equal).trim();
  const part = filter.slice(equal + 1).trim();
  const dot = part.indexOf(".");
  if (!column || dot < 0) return null;
  const operator = part.slice(0, dot);
  const value = part.slice(dot + 1);
  if (!isFilterOperator(operator) || (operator === "in" && !inMembers(value))) return null;
  return { column, operator, value };
}

function comparable(value: string, current: string | number | boolean): string | number | boolean | undefined {
  if (typeof current === "number") {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof current === "boolean") return value === "true" ? true : value === "false" ? false : undefined;
  return value;
}

function likeMatch(value: string, pattern: string): boolean {
  if (value.length > 8192) return false;
  const tokens: Array<{ kind: "many" } | { kind: "one" } | { kind: "literal"; value: string }> = [];
  let escaped = false;
  for (const char of pattern) {
    if (escaped) {
      tokens.push({ kind: "literal", value: char });
      escaped = false;
    } else if (char === "\\") escaped = true;
    else if (char === "%") tokens.push({ kind: "many" });
    else if (char === "_") tokens.push({ kind: "one" });
    else tokens.push({ kind: "literal", value: char });
  }
  if (escaped) return false;
  // Bounded dynamic programming avoids attacker-controlled regexp backtracking.
  let previous = new Uint8Array(tokens.length + 1);
  previous[0] = 1;
  for (const [index, token] of tokens.entries()) {
    if (token.kind === "many") previous[index + 1] = previous[index] ?? 0;
  }
  for (const char of value) {
    const current = new Uint8Array(tokens.length + 1);
    for (const [index, token] of tokens.entries()) {
      current[index + 1] = token.kind === "many"
        ? (current[index] || previous[index + 1] ? 1 : 0)
        : previous[index] && (token.kind === "one" || token.value === char) ? 1 : 0;
    }
    previous = current;
  }
  return previous[tokens.length] === 1;
}

function inMembers(value: string): string[] | null {
  if (!value.startsWith("(") || !value.endsWith(")")) return null;
  const parts: string[] = [];
  let member = "";
  let quoted = false;
  let escaped = false;
  for (const char of value.slice(1, -1)) {
    if (escaped) escaped = false;
    else if (char === "\\" && quoted) escaped = true;
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { parts.push(member.trim()); member = ""; continue; }
    member += char;
  }
  if (quoted || escaped) return null;
  parts.push(member.trim());
  const members: string[] = [];
  for (const part of parts) {
    if (part.startsWith('"')) {
      const parsed = decodeRealtimeQuotedScalar(part);
      if (parsed === null) return null;
      members.push(parsed);
    } else {
      if (!part || /["()]/.test(part)) return null;
      members.push(part);
    }
  }
  return members;
}

export function matchesRealtimeFilter(filter: string, record: Record<string, unknown>): boolean {
  const parsed = parseFilter(filter);
  if (!parsed || !Object.hasOwn(record, parsed.column)) return false;
  const current = record[parsed.column];
  if (typeof current !== "string" && typeof current !== "number" && typeof current !== "boolean") return false;
  if (typeof current === "number" && !Number.isFinite(current)) return false;
  if (parsed.operator === "in") {
    const members = inMembers(parsed.value);
    return members !== null && members.some((member) => comparable(member, current) === current);
  }
  if (parsed.operator === "like" || parsed.operator === "ilike") {
    if (typeof current !== "string") return false;
    return parsed.operator === "like" ? likeMatch(current, parsed.value)
      : likeMatch(current.toLowerCase(), parsed.value.toLowerCase());
  }
  const value = comparable(parsed.value, current);
  if (value === undefined) return false;
  switch (parsed.operator) {
    case "eq": return current === value;
    case "neq": return current !== value;
    case "gt": return current > value;
    case "gte": return current >= value;
    case "lt": return current < value;
    case "lte": return current <= value;
  }
}
