import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { WorkerPool } from "./worker-pool";

const resources: { pool: WorkerPool; root: string }[] = [];
afterEach(async () => {
  for (const { pool, root } of resources.splice(0)) {
    await pool.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(homedir(), ".supacloud-worker-lifecycle-"));
  const file = join(root, "fn.ts");
  await Bun.write(file, 'export default () => new Response("ok");');
  const pool = new WorkerPool({ size: 1, requestTimeout: 2_000, preheatTimeoutMs: 10_000 });
  resources.push({ pool, root });
  const workers = (pool as unknown as { activeWorkers: Set<Worker> }).activeWorkers;
  const dispatch = () => pool.dispatch({
    functionId: "lifecycle", projectRef: "lifecycle", projectRoot: root,
    functionPath: file, env: {}, request: new Request("http://edge.test/function"),
  });
  return { pool, root, file, workers, dispatch };
}

test.each(["error", "exit"] as const)("preheat fails once on %s and ignores late success", async (event) => {
  const { pool, root, file, workers, dispatch } = await fixture();
  const worker = workers.values().next().value!;
  const post = worker.postMessage.bind(worker);
  const intercept = spyOn(worker, "postMessage").mockImplementation((message, transfer) => {
    if (message.type !== "preheat") return post(message, transfer);
    queueMicrotask(() => {
      worker.emit(event, event === "error" ? new Error("preheat crash") : 1);
      worker.emit("message", {
        type: "preheat_done", functionId: "lifecycle", moduleCacheHit: false,
        moduleCacheSize: 1, heapSize: 12345,
      });
    });
  });
  try {
    const preheat = pool.preheat("lifecycle", file, root, {}, {
      projectRef: "lifecycle", bytecode: "off",
    });
    expect(await Promise.race([preheat, Bun.sleep(1_000).then(() => "timeout")])).toBe(false);
    const metrics = pool.snapshotMetrics();
    expect(metrics.supacloud_edge_total_worker_replacements).toBe(1);
    expect(metrics.supacloud_edge_total_worker_retirements).toBe(1);
    expect(metrics.supacloud_edge_worker_heap_bytes).toBe(0);
    expect(workers.has(worker)).toBe(false);
    expect(await (await dispatch()).text()).toBe("ok");
  } finally {
    intercept.mockRestore();
  }
});

test("warm executions keep a single lifecycle listener and recover an idle error", async () => {
  const { pool, workers, dispatch } = await fixture();
  const worker = workers.values().next().value!;
  for (let index = 0; index < 20; index++) {
    expect(await (await dispatch()).text()).toBe("ok");
    for (const event of ["message", "error", "exit"]) expect(worker.listenerCount(event)).toBe(1);
  }
  worker.emit("error", new Error("idle crash"));
  expect(workers.has(worker)).toBe(false);
  expect(await (await dispatch()).text()).toBe("ok");
  expect(pool.snapshotMetrics().supacloud_edge_total_worker_replacements).toBe(1);
});
