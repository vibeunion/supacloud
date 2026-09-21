// @supacloud-test-isolate
import { expect, mock, test } from "bun:test";
import { withNativePostgres } from "../helpers/native-postgres";

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
  "native lease recovery does not replay started functions with unknown outcomes",
  async () => withNativePostgres(async (database) => {
    const originalDb = await import("../../src/db");
    mock.module("../../src/db", () => ({ ...originalDb, sql: database }));
    const { recoverExpiredLeases } = await import("../../src/repositories/task.repository");
    await database`
      CREATE TABLE project_tasks (
        id text PRIMARY KEY, project_ref text NOT NULL, task_type text NOT NULL, status text NOT NULL,
        attempt integer NOT NULL DEFAULT 1, max_attempts integer NOT NULL DEFAULT 3,
        lease_until timestamptz, cancel_requested_at timestamptz, next_run_at timestamptz DEFAULT '2020-01-01',
        completed_at timestamptz, updated_at timestamptz DEFAULT NOW(), error text
      )
    `;
    await database`
      INSERT INTO project_tasks (id, project_ref, task_type, status, lease_until) VALUES
      ('running', 'a', 'edge_function', 'running', NOW() - INTERVAL '1 minute'),
      ('leased', 'a', 'edge_function', 'leased', NOW() - INTERVAL '1 minute'),
      ('exhausted', 'a', 'edge_function', 'leased', NOW() - INTERVAL '1 minute'),
      ('other', 'b', 'edge_function', 'running', NOW() - INTERVAL '1 minute'),
      ('live', 'a', 'edge_function', 'running', NOW() + INTERVAL '1 minute'),
      ('cancelled', 'a', 'edge_function', 'running', NOW() - INTERVAL '1 minute'),
      ('queue', 'a', 'queue:work', 'running', NOW() - INTERVAL '1 minute')
    `;
    await database`UPDATE project_tasks SET attempt = 3 WHERE id = 'exhausted'`;
    await database`UPDATE project_tasks SET cancel_requested_at = NOW() WHERE id = 'cancelled'`;
    expect(await recoverExpiredLeases("a", ["edge_function"])).toBe(3);
    const rows: unknown = await database`
      SELECT id, status, completed_at IS NOT NULL AS terminal,
        error LIKE '%outcome is unknown%' AS unknown_outcome
      FROM project_tasks ORDER BY id
    `;
    expect(rows).toEqual([
      { id: "cancelled", status: "running", terminal: false, unknown_outcome: null },
      { id: "exhausted", status: "dead_lettered", terminal: true, unknown_outcome: false },
      { id: "leased", status: "retry_scheduled", terminal: false, unknown_outcome: false },
      { id: "live", status: "running", terminal: false, unknown_outcome: null },
      { id: "other", status: "running", terminal: false, unknown_outcome: null },
      { id: "queue", status: "running", terminal: false, unknown_outcome: null },
      { id: "running", status: "dead_lettered", terminal: true, unknown_outcome: true },
    ]);
    expect(await recoverExpiredLeases("a", ["edge_function"])).toBe(0);
    expect(await recoverExpiredLeases(undefined, ["queue:work"])).toBe(1);
    const queue: unknown = await database`SELECT status FROM project_tasks WHERE id = 'queue'`;
    expect(queue).toEqual([{ status: "retry_scheduled" }]);
  }),
  40_000,
);
