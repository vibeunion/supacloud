import { expect, test } from "bun:test";
import { decodeNotebook, decodeNotebookPage } from "./sql-notebooks";
import { decodeAdvisorPayload, decodeConnectionRows } from "./project-advisors";

test("notebook decoders reject cross-project, malformed and lossy responses", () => {
  const row = { id: crypto.randomUUID(), project_ref: "demo", name: "query", content: "中", content_bytes: 3, revision: 1 };
  expect(decodeNotebook(row, "demo").content).toBe("中");
  expect(() => decodeNotebook(row, "other")).toThrow();
  expect(() => decodeNotebook({ ...row, revision: "1" }, "demo")).toThrow();
  expect(() => decodeNotebook({ ...row, content_bytes: 1 }, "demo")).toThrow();
  expect(() => decodeNotebookPage({ project_ref: "demo", items: [row, null], next_offset: null }, "demo")).toThrow();
});
test("advisors preserve unknown and fail closed on partial or cross-project evidence", () => {
  const payload = {
    schema: "supacloud.project-advisors.v1", project_ref: "demo",
    error_rates: ["data_api", "auth", "storage", "edge_functions"].map(service =>
      ({ service, observations: 0, errors: 0, error_rate: null, status: "unknown" })),
    database: { available: false, connections: { active: null, max: null }, blocked_sessions: null,
      unused_indexes: null, tables_without_rls: [], forced_rls_tables: [] },
    edge_functions: { available: false, count: null },
  };
  expect(decodeAdvisorPayload(payload, "demo").database.available).toBe(false);
  expect(() => decodeAdvisorPayload(payload, "other")).toThrow();
  expect(() => decodeAdvisorPayload({ ...payload, error_rates: [] }, "demo")).toThrow();
  expect(() => decodeAdvisorPayload({ ...payload, database: { ...payload.database, available: true } }, "demo")).toThrow();
  expect(() => decodeConnectionRows({ project_ref: "other", rows: [], truncated: false }, "demo")).toThrow();
});
