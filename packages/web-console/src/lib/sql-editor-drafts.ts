export interface SqlEditorDraft {
  id: string;
  name: string;
  sql: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSqlEditorDrafts(value: unknown): SqlEditorDraft[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Invalid SQL drafts");
  const ids = new Set<string>();
  const drafts: SqlEditorDraft[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim()
      || typeof entry.name !== "string" || !entry.name.trim() || typeof entry.sql !== "string"
      || ids.has(entry.id)) {
      throw new Error("Invalid SQL drafts");
    }
    ids.add(entry.id);
    drafts.push({ id: entry.id, name: entry.name, sql: entry.sql });
  }
  return drafts;
}

export function serializeSqlEditorDrafts(drafts: readonly SqlEditorDraft[]): string {
  return JSON.stringify(drafts.map(({ id, name, sql }) => ({ id, name, sql })));
}

export function wrapSqlWithRole(sql: string, role: string): string {
  if (role === "postgres") return sql;
  if (!role.trim() || role.includes("\0")) throw new Error("Invalid SQL role");
  return `SET ROLE "${role.replace(/"/g, '""')}";\n${sql}\nRESET ROLE;`;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[,\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function sqlRowsToCsv(rows: readonly Record<string, unknown>[]): string {
  const first = rows[0];
  if (!first) return "";
  const headers = Object.keys(first);
  return [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\n");
}
