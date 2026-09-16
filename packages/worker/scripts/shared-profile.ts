import { parse } from "libpg-query";

const optionalFunctions = new Set([
  "ensure_workers", "cleanup_ensure_workers_logs",
  "setup_ensure_workers_cron", "setup_requeue_stalled_tasks_cron",
]);
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function functionName(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map(item => record(record(item).String).sval).join(".");
}
function optionalName(value: unknown): boolean {
  const name = functionName(value);
  return name.startsWith("pgflow.") && optionalFunctions.has(name.slice(7));
}

/** Keep engine SQL byte-for-byte; remove only parsed optional host integration statements. */
export async function sharedProfile(sql: string): Promise<string> {
  const parsed = await parse(sql);
  const bytes = Buffer.from(sql);
  const kept: string[] = [];
  for (const statement of parsed.stmts) {
    const node = record(statement.stmt);
    const extension = record(node.CreateExtensionStmt).extname;
    if (extension === "pg_cron" || extension === "pg_net") continue;
    if (optionalName(record(node.CreateFunctionStmt).funcname)) continue;
    const comment = record(node.CommentStmt);
    if (comment.objtype === "OBJECT_FUNCTION"
      && optionalName(record(record(comment.object).ObjectWithArgs).objname)) continue;
    const targets = record(node.SelectStmt).targetList;
    if (Array.isArray(targets) && targets.length === 1) {
      const call = record(record(record(targets[0]).ResTarget).val).FuncCall;
      if (optionalName(record(call).funcname)) continue;
    }
    const start = statement.stmt_location ?? 0;
    const end = statement.stmt_len ? start + statement.stmt_len : bytes.length;
    kept.push(bytes.subarray(start, end).toString("utf8").trim().replace(/;$/, "") + ";");
  }
  return kept.join("\n");
}
