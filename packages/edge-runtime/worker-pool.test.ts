import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkerPool } from "./worker-pool";

const pools: WorkerPool[] = [];

afterEach(async () => {
  for (const pool of pools.splice(0)) {
    for (const worker of (pool as any).workers || []) {
      await worker.terminate();
    }
  }
});

async function waitForFile(path: string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return Bun.file(path).text();
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

describe("WorkerPool EdgeRuntime.waitUntil", () => {
  test("keeps tenant env available after the HTTP response is returned", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supacloud-waituntil-"));
    const outputPath = join(projectRoot, "waituntil.txt");
    const functionPath = join(projectRoot, "fn.ts");
    await Bun.write(functionPath, `
      export default {
        async fetch() {
          globalThis.EdgeRuntime.waitUntil((async () => {
            await Bun.sleep(25);
            await Bun.write(process.env.OUT_FILE, process.env.SUPABASE_URL || "missing");
          })());
          return new Response("queued", { status: 202 });
        }
      }
    `);

    const pool = new WorkerPool({ size: 1, requestTimeout: 2_000 });
    pools.push(pool);

    try {
      const response = await pool.dispatch({
        functionId: "proj_waituntil",
        functionPath,
        projectRoot,
        env: {
          OUT_FILE: outputPath,
          SUPABASE_URL: "http://tenant.local",
        },
        request: new Request("http://edge.local/functions/v1/waituntil", { method: "POST" }),
      });

      expect(response.status).toBe(202);
      expect(await response.text()).toBe("queued");
      expect(await waitForFile(outputPath)).toBe("http://tenant.local");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
