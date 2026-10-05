export interface NotebookSummary {
  id: string; project_ref: string; name: string; revision: number; content_bytes: number;
}
export interface Notebook extends NotebookSummary { content: string }
export interface NotebookPage { items: NotebookSummary[]; next_offset: number | null }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function decodeNotebookSummary(value: unknown, ref: string): NotebookSummary {
  if (!record(value) || value.project_ref !== ref || typeof value.id !== "string" || !UUID.test(value.id)
    || typeof value.name !== "string" || !value.name || value.name.length > 160
    || !integer(value.revision) || value.revision < 1
    || !integer(value.content_bytes) || value.content_bytes > 1_000_000) throw new Error("笔记本数据格式无效");
  return { id: value.id, project_ref: ref, name: value.name, revision: value.revision, content_bytes: value.content_bytes };
}
export function decodeNotebook(value: unknown, ref: string, id?: string): Notebook {
  const summary = decodeNotebookSummary(value, ref);
  if (!record(value) || (id !== undefined && summary.id !== id) || typeof value.content !== "string"
    || new TextEncoder().encode(value.content).byteLength !== summary.content_bytes) throw new Error("笔记本内容格式无效");
  return { ...summary, content: value.content };
}
export function decodeNotebookPage(value: unknown, ref: string): NotebookPage {
  if (!record(value) || value.project_ref !== ref || !Array.isArray(value.items) || value.items.length > 200
    || (value.next_offset !== null && !integer(value.next_offset))) throw new Error("笔记本列表格式无效");
  const items = value.items.map(item => decodeNotebookSummary(item, ref));
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error("笔记本列表格式无效");
  return { items, next_offset: value.next_offset };
}
export function notebookResponseStatus(value: unknown, status: number): void {
  if (status === 409) {
    throw new Error(record(value) && value.code === "NOTEBOOK_NAME_CONFLICT"
      ? "笔记本名称已存在，请修改名称"
      : "笔记本已被其他编辑器更新；本地 SQL 已保留，请加载最新版本或另存");
  }
}
