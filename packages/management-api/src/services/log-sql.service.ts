import { Database } from "bun:sqlite";
import { parse, toSql, type Expr } from "pgsql-ast-parser";
import { victoriaLogsService, type VictoriaProjectLog } from "./victorialogs.service";
import { redactLogMessage } from "../utils/log-record";

const COLUMNS = new Set(["id", "timestamp", "event_message", "severity", "service", "project_ref", "metadata"]);
const FUNCTIONS = new Set(["count", "min", "max", "sum", "avg", "lower", "upper", "length", "coalesce"]);
const OPERATORS = new Set(["=", "!=", ">", ">=", "<", "<=", "LIKE", "NOT LIKE", "IN", "NOT IN", "AND", "OR", "+", "-", "*", "/", "%"]);

export class LogSqlError extends Error {}

function validateExpression(expr: Expr, names: Set<string>, depth = 0): void {
  if (depth > 16) throw new LogSqlError("Expression nesting exceeds limit");
  const next = (child: Expr) => validateExpression(child, names, depth + 1);
  switch (expr.type) {
    case "ref":
      if (expr.table || (!names.has(expr.name) && expr.name !== "*")) throw new LogSqlError("Unknown log column");
      return;
    case "null": case "string": case "integer": case "numeric": case "boolean": return;
    case "binary":
      if (expr.opSchema || !OPERATORS.has(expr.op)) throw new LogSqlError("Unsupported log operator");
      next(expr.left); next(expr.right); return;
    case "unary":
      if (expr.opSchema || !["NOT", "-", "+", "IS NULL", "IS NOT NULL"].includes(expr.op)) throw new LogSqlError("Unsupported log operator");
      next(expr.operand); return;
    case "list":
      expr.expressions.forEach(next); return;
    case "call":
      if (expr.function.schema || !FUNCTIONS.has(expr.function.name) || expr.over || expr.orderBy || expr.withinGroup || expr.filter
        || expr.args.length > 8) throw new LogSqlError("Unsupported log function");
      expr.args.forEach(next); return;
    default: throw new LogSqlError("Unsupported log expression");
  }
}

export function prepareLogSql(query: string): string {
  if (!query.trim() || Buffer.byteLength(query) > 16384) throw new LogSqlError("Log SQL exceeds size limit");
  try {
    const statements = parse(query);
    const statement = statements[0];
    if (statements.length !== 1 || statement?.type !== "select" || statement.for || statement.skip
      || Array.isArray(statement.distinct)) throw new LogSqlError("Only one read-only SELECT is allowed");
    const from = statement.from?.[0];
    if (statement.from?.length !== 1 || from?.type !== "table" || from.join || from.lateral
      || from.name.name !== "project_logs" || from.name.schema || from.name.alias || from.name.columnNames) {
      throw new LogSqlError("Only FROM project_logs is allowed; joins and subqueries are disabled");
    }
    if (!statement.columns?.length || statement.columns.length > 30) throw new LogSqlError("Invalid SELECT list");
    const names = new Set(COLUMNS);
    for (const column of statement.columns) {
      validateExpression(column.expr, COLUMNS);
      if (column.alias) names.add(column.alias.name);
    }
    if (statement.where) validateExpression(statement.where, COLUMNS);
    if (statement.having) validateExpression(statement.having, names);
    for (const item of statement.groupBy ?? []) validateExpression(item, names);
    for (const item of statement.orderBy ?? []) validateExpression(item.by, names);
    for (const limit of [statement.limit?.limit, statement.limit?.offset]) {
      if (limit && (limit.type !== "integer" || limit.value < 0 || limit.value > 1000)) throw new LogSqlError("Invalid LIMIT/OFFSET");
    }
    // Render only the parsed, validated AST, never untrusted SQL bytes.
    return toSql.statement(statement);
  } catch (error) {
    if (error instanceof LogSqlError) throw error;
    throw new LogSqlError("Invalid log SQL");
  }
}

function redactMessage(value: string, depth: number): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === "object") return JSON.stringify(redacted(parsed, depth + 1));
  } catch { /* Unstructured messages still receive token and connection-string redaction. */ }
  return redactLogMessage(value).replace(
    /((?:password|passwd|secret|api[_-]?key|service[_-]?role[_-]?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    "$1[REDACTED]",
  );
}

function redacted(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[truncated]";
  if (typeof value === "string") return redactMessage(value, depth);
  if (Array.isArray(value)) return value.map(item => redacted(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !/password|secret|token|authorization|credential|(?:private|api|anon|service[_-]?role)[_-]?key|cookie/i.test(key))
    .map(([key, item]) => [key, redacted(item, depth + 1)]));
}

export function redactProjectLogs(logs: VictoriaProjectLog[]): VictoriaProjectLog[] {
  return logs.map(log => ({
    ...log, event_message: redactMessage(log.event_message, 0),
    metadata: Object.fromEntries(Object.entries(log.metadata).filter(([key]) =>
      !/password|secret|token|authorization|credential|(?:private|api|anon|service[_-]?role)[_-]?key|cookie/i.test(key))
      .map(([key, value]) => [key, redacted(value)])),
  }));
}

export function executeLogSnapshot(ref: string, preparedSql: string, logs: VictoriaProjectLog[]) {
  const query = prepareLogSql(preparedSql);
  if (logs.length > 1000 || Buffer.byteLength(JSON.stringify(logs)) > 16 * 1024 * 1024) {
    throw new LogSqlError("Log source exceeds size limit");
  }
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE project_logs (id TEXT, timestamp TEXT, event_message TEXT, severity TEXT, service TEXT, project_ref TEXT, metadata TEXT)");
    const insert = db.prepare("INSERT INTO project_logs VALUES (?, ?, ?, ?, ?, ?, ?)");
    db.transaction(() => {
      for (const log of logs) insert.run(log.id, log.timestamp, redactMessage(log.event_message, 0), log.severity, log.service, ref, JSON.stringify(redacted(log.metadata)));
    })();
    db.exec("PRAGMA query_only = ON");
    let rows: Record<string, unknown>[];
    try { rows = db.prepare<Record<string, unknown>, []>(`SELECT * FROM (${query}) LIMIT 501`).all(); }
    catch { throw new LogSqlError("Unsupported bounded log SELECT"); }
    if (Buffer.byteLength(JSON.stringify(rows)) > 2 * 1024 * 1024) throw new LogSqlError("Log result exceeds size limit; select fewer columns");
    return { rows: rows.slice(0, 500), result_truncated: rows.length > 500 };
  } finally { db.close(); }
}

export async function queryProjectLogsSql(ref: string, query: string) {
  const prepared = prepareLogSql(query);
  const end = new Date().toISOString();
  const start = new Date(Date.parse(end) - 60 * 60 * 1000).toISOString();
  const logs = await victoriaLogsService.queryProjectLogs(ref, { limit: 1000, start, end });
  const result = executeLogSnapshot(ref, prepared, logs);
  return {
    project_ref: ref, ...result, returned_rows: result.rows.length, source_rows: logs.length,
    source_truncated: logs.length >= 1000, truncated: logs.length >= 1000 || result.result_truncated,
    window: { start, end }, dialect: "bounded-select", read_only: true,
  };
}
