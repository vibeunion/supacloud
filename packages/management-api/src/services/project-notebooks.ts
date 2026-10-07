import { sql } from "../db";

export interface NotebookScope {
  ref: string;
  owner: string;
}

export interface NotebookSummary {
  id: string;
  project_ref: string;
  name: string;
  revision: number;
  content_bytes: number;
}

export interface Notebook extends NotebookSummary {
  content: string;
}

export interface NotebookStore {
  list(scope: NotebookScope, offset: number): Promise<NotebookSummary[]>;
  read(scope: NotebookScope, id: string): Promise<Notebook | null>;
  create(scope: NotebookScope, name: string, content: string): Promise<Notebook | null>;
  update(scope: NotebookScope, id: string, revision: number, name?: string, content?: string): Promise<Notebook | null>;
  delete(scope: NotebookScope, id: string, revision: number): Promise<boolean>;
}

type NotebookSummaryRow = Omit<NotebookSummary, "revision"> & {
  revision: number | string | bigint;
};
type NotebookRow = NotebookSummaryRow & { content: string };

export function normalizeNotebook<T extends NotebookSummaryRow>(row: T): Omit<T, "revision"> & { revision: number } {
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Invalid notebook revision");
  return { ...row, revision };
}

export const notebookStore: NotebookStore = {
  async list({ ref, owner }, offset) {
    const rows = await sql<NotebookSummaryRow[]>`
      SELECT id, project_ref, name, revision,
             octet_length(content)::int AS content_bytes
      FROM project_notebooks
      WHERE project_ref = ${ref} AND owner_principal = ${owner}
      ORDER BY updated_at DESC, id
      LIMIT 201 OFFSET ${offset}
    `;
    return rows.map(normalizeNotebook);
  },

  async read({ ref, owner }, id) {
    const [row] = await sql<NotebookRow[]>`
      SELECT id, project_ref, name, content, revision,
             octet_length(content)::int AS content_bytes
      FROM project_notebooks
      WHERE id = ${id} AND project_ref = ${ref} AND owner_principal = ${owner}
    `;
    return row ? normalizeNotebook(row) : null;
  },

  async create({ ref, owner }, name, content) {
    const [row] = await sql<NotebookRow[]>`
      INSERT INTO project_notebooks(project_ref, owner_principal, name, content)
      VALUES (${ref}, ${owner}, ${name}, ${content})
      ON CONFLICT (project_ref, owner_principal, name) DO NOTHING
      RETURNING id, project_ref, name, content, revision,
                octet_length(content)::int AS content_bytes
    `;
    return row ? normalizeNotebook(row) : null;
  },

  async update({ ref, owner }, id, revision, name, content) {
    const [row] = await sql<NotebookRow[]>`
      UPDATE project_notebooks
      SET name = COALESCE(${name ?? null}, name),
          content = COALESCE(${content ?? null}, content),
          revision = revision + 1,
          updated_at = NOW()
      WHERE id = ${id} AND project_ref = ${ref} AND owner_principal = ${owner}
        AND revision = ${revision}
        AND revision < 9007199254740991
      RETURNING id, project_ref, name, content, revision,
                octet_length(content)::int AS content_bytes
    `;
    return row ? normalizeNotebook(row) : null;
  },

  async delete({ ref, owner }, id, revision) {
    const rows = await sql<{ id: string }[]>`
      DELETE FROM project_notebooks
      WHERE id = ${id} AND project_ref = ${ref}
        AND owner_principal = ${owner} AND revision = ${revision}
      RETURNING id
    `;
    return rows.length === 1;
  },
};
