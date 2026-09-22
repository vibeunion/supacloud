export type RealtimeFilterOperator =
  | "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "like" | "ilike"
  | "is" | "match" | "imatch" | "isdistinct";
export interface RealtimeFilterCondition {
  column: string;
  operator: RealtimeFilterOperator;
  negate: boolean;
  value: string;
}

function operator(value: string): value is RealtimeFilterOperator {
  return ["eq", "neq", "gt", "gte", "lt", "lte", "in", "like", "ilike",
    "is", "match", "imatch", "isdistinct"].includes(value);
}

function splitConditions(value: string, allowParentheses: boolean): string[] | null {
  const conditions: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let parentheses = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (escaped) { escaped = false; continue; }
    if (quoted && char === "\\") { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (char === "(") {
      if (!allowParentheses || ++parentheses > 1) return null;
    } else if (char === ")") {
      if (--parentheses < 0) return null;
    } else if (char === "," && parentheses === 0) {
      conditions.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted || escaped || parentheses !== 0) return null;
  conditions.push(value.slice(start));
  return conditions;
}

export function decodeRealtimeQuotedScalar(value: string): string | null {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return null;
  let result = "";
  for (let index = 1; index < value.length - 1; index++) {
    const char = value[index];
    if (char === '"') return null;
    if (char === "\\") {
      const next = value[++index];
      if (index >= value.length - 1 || (next !== "\\" && next !== '"')) return null;
      result += next;
    } else result += char;
  }
  return result;
}

function validScalar(value: string, allowEmpty: boolean): boolean {
  if (!value) return allowEmpty;
  if (value.startsWith('"')) return decodeRealtimeQuotedScalar(value) !== null;
  return !/[",()]/.test(value);
}

export function parseRealtimeFilter(filter: string): RealtimeFilterCondition[] | null {
  if (filter.length > 512) return null;
  if (filter === "") return [];
  const parts = splitConditions(filter, true);
  if (!parts || parts.length > 32) return null;
  const result: RealtimeFilterCondition[] = [];
  for (const part of parts) {
    const equal = part.indexOf("=");
    if (equal <= 0) return null;
    const column = part.slice(0, equal).trim();
    if (!column || column.includes("\0") || Buffer.byteLength(column) > 63) return null;
    let rest = part.slice(equal + 1).trim();
    const negate = rest.startsWith("not.");
    if (negate) rest = rest.slice(4);
    const dot = rest.indexOf(".");
    if (dot < 0) return null;
    const op = rest.slice(0, dot);
    const value = rest.slice(dot + 1);
    if (!operator(op)) return null;
    if (op === "in") {
      if (!value.startsWith("(") || !value.endsWith(")")) return null;
      const members = splitConditions(value.slice(1, -1), false);
      if (!members?.length || !members.every((member) => validScalar(member.trim(), false))) return null;
    } else if (op === "is") {
      if (!["null", "true", "false", "unknown"].includes(value)) return null;
    } else if (!validScalar(value, true)) return null;
    result.push({ column, operator: op, negate, value });
  }
  return result;
}

export function canEvaluateRealtimeFilterNatively(filter: string | undefined): boolean {
  if (!filter) return true;
  const conditions = parseRealtimeFilter(filter);
  const condition = conditions?.[0];
  return conditions?.length === 1 && !!condition && !condition.negate
    && ["eq", "neq", "gt", "gte", "lt", "lte", "in", "like", "ilike"].includes(condition.operator)
    && !condition.value.startsWith('"');
}
