import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sharedRuntimeCapacityGaps, type TenantCapacityBudget } from "@supacloud/delivery/tenant-capacity";
import { WorkerPool } from "./worker-pool";

const pools: WorkerPool[] = [];
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.shutdown();
});

function budget(overrides: Partial<TenantCapacityBudget> = {}): TenantCapacityBudget {
  return {
    cpu: 4,
    memoryMiB: 4096,
    connections: 20,
    queue: 1,
    storageBytes: 1_000_000,
    functionConcurrency: 1,
    ...overrides,
  };
}

test("a noisy tenant is capped while the other tenant still runs", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-noisy-"));
  const functionPath = join(projectRoot, "fn.ts");
  const orderPath = join(projectRoot, "order.txt");
  const releasePath = join(projectRoot, "release.txt");
  await Bun.write(orderPath, "");
  await Bun.write(functionPath, `
    export default {
      async fetch(request) {
        const label = new URL(request.url).pathname.slice(1);
        const previous = await Bun.file(process.env.ORDER_FILE).text();
        await Bun.write(process.env.ORDER_FILE, previous + label + "\\n");
        if (label === "a0") {
          while (!(await Bun.file(process.env.RELEASE_FILE).exists())) await Bun.sleep(10);
        }
        return new Response(label);
      }
    }
  `);
  const pool = new WorkerPool({
    size: 2,
    requestTimeout: 8_000,
    tenantCapacity: projectRef => projectRef === "project-a" || projectRef === "project-b" ? budget() : null,
  });
  pools.push(pool);
  const dispatch = (projectRef: string, label: string, requestId: string) => pool.dispatch({
    functionId: `${projectRef}_fn`,
    projectRef,
    functionPath,
    projectRoot,
    env: { ORDER_FILE: orderPath, RELEASE_FILE: releasePath },
    request: new Request(`http://edge.local/${label}`, { headers: { "x-request-id": requestId } }),
  });

  try {
    const waitForOrder = async (label: string) => {
      const started = Date.now();
      while (Date.now() - started < 4_000) {
        const text = await Bun.file(orderPath).text();
        if (text.split("\n").includes(label)) return;
        await Bun.sleep(10);
      }
      throw new Error(`order did not include ${label}: ${JSON.stringify(await Bun.file(orderPath).text())}`);
    };
    const first = dispatch("project-a", "a0", "req-a0");
    await waitForOrder("a0");
    const queued = dispatch("project-a", "a1", "req-a1");
    const rejected = await dispatch("project-a", "a2", "req-a2");
    const quiet = dispatch("project-b", "b0", "req-b0");
    await waitForOrder("b0");
    await Bun.write(releasePath, "go");
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("x-request-id")).toBe("req-a2");
    expect(rejected.headers.get("x-supacloud-project-ref")).toBe("project-a");
    expect(await rejected.json()).toMatchObject({
      code: "TENANT_CAPACITY_EXCEEDED",
      projectRef: "project-a",
      dimension: "functionConcurrency",
    });
    const quietResponse = await quiet;
    expect(quietResponse.status).toBe(200);
    expect(await quietResponse.text()).toBe("b0");
    const [firstResponse, queuedResponse] = await Promise.all([first, queued]);
    await firstResponse.body?.cancel();
    await queuedResponse.body?.cancel();
    const order = (await Bun.file(orderPath).text()).trim().split("\n");
    expect(order).toEqual(["a0", "b0", "a1"]);
    expect(pool.snapshotMetrics("noisy").noisy_total_tenant_capacity_rejected).toBe(1);
    expect(sharedRuntimeCapacityGaps.map(gap => gap.dimension)).toEqual(["cpu", "connections", "storageBytes"]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
