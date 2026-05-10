import { describe, expect, test } from "bun:test";

async function read(relativePath: string): Promise<string> {
  return Bun.file(new URL(relativePath, import.meta.url)).text();
}

describe("performance regressions", () => {
  test("dashboard summary route keeps the console off the multi-SQL hot path", async () => {
    const routeSource = await read("../../src/routes/project-dashboard.ts");
    const pageSource = await read("../../../web-console/src/routes/project/[ref]/+page.svelte");

    expect(routeSource).toContain('"/:ref/dashboard/summary"');
    expect(routeSource).toContain("DASHBOARD_SUMMARY_CACHE_TTL_MS");
    expect(routeSource).toContain("edgeFunctionService.list(params.ref)");
    expect(routeSource).toContain("taskRepository.getTaskStats(params.ref)");
    expect(pageSource).toContain("dashboard/summary");
    expect(pageSource).toContain("fetchDashboardLegacy");
    expect(pageSource).not.toContain("fetchFunctions(); fetchTaskStats();");
  });

  test("task list summary mode avoids large JSON payloads and has queue indexes", async () => {
    const repositorySource = await read("../../src/repositories/task.repository.ts");
    const dbInitSource = await read("../../src/db/init.ts");

    expect(repositorySource).toContain("summary?: boolean");
    expect(repositorySource).toContain("'{}'::jsonb AS payload");
    expect(repositorySource).toContain("NULL::jsonb AS result");
    expect(dbInitSource).toContain("idx_project_tasks_queue_ready");
    expect(dbInitSource).toContain("idx_project_tasks_active_lease");
    expect(dbInitSource).toContain("idx_project_tasks_project_created_desc");
  });

  test("storage batch operations are concurrency-limited and listing is paged in SQL", async () => {
    const storageRouteSource = await read("../../src/routes/storage-compat.ts");
    const storageRlsSource = await read("../../src/services/storage-rls.ts");

    expect(storageRouteSource).toContain("STORAGE_BATCH_CONCURRENCY");
    expect(storageRouteSource).toContain("mapWithConcurrency(paths");
    expect(storageRouteSource).toContain("mapWithConcurrency(\n            prefixes");
    expect(storageRlsSource).toContain("WITH candidates AS");
    expect(storageRlsSource).toContain("LIMIT $7 OFFSET $8");
  });
});
