import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const worker = join(import.meta.dir, "delivery-bundle-worker.ts");

test("worker rejects invalid protocol input without echoing it", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", worker], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  child.stdin.write(JSON.stringify({ secret: "PRIVATE_INVALID_BUNDLE_INPUT" }));
  child.stdin.end();
  const [status, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(status).toBe(1);
  expect(JSON.parse(stdout)).toEqual({ ok: false });
  expect(stderr).toBe("");
  expect(stdout).not.toContain("PRIVATE_INVALID_BUNDLE_INPUT");
});

test("isolated bundle children are reaped on cancellation and caller termination", async () => {
  const project = await mkdtemp(join(tmpdir(), "bundle-cancellation-"));
  try {
    for (const signal of ["SIGINT", "SIGTERM", "SIGKILL"] as const) {
      const script = `import {bundleDeliveryTarget} from ${JSON.stringify(join(import.meta.dir, "delivery-bundle.ts"))};
        const spawn = Bun.spawn;
        Bun.spawn = (...args) => {
          const child = spawn(...args);
          queueMicrotask(() => console.log(JSON.stringify({pid: child.pid})));
          return child;
        };
        try {
          await bundleDeliveryTarget("api", "export const value = 1;", ${JSON.stringify(project)}, ${JSON.stringify(project)}, {version: 1});
        } catch {
          console.log("interrupted");
          process.exitCode = 2;
        }`;
      const parent = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
        cwd: project, stdout: "pipe", stderr: "pipe",
      });
      const errors = new Response(parent.stderr).text();
      const reader = parent.stdout.getReader();
      const timeout = setTimeout(() => parent.kill("SIGKILL"), 10_000);
      let workerPid: number | undefined;
      const alive = () => {
        if (workerPid === undefined) return false;
        try { process.kill(workerPid, 0); return true; } catch { return false; }
      };
      try {
        let output = "";
        while (!output.includes("\n")) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("Caller exited before spawning bundle worker");
          output += new TextDecoder().decode(chunk.value);
        }
        workerPid = JSON.parse(output.split("\n")[0]!).pid;
        expect(Number.isSafeInteger(workerPid)).toBe(true);
        expect(alive()).toBe(true);
        parent.kill(signal);
        const status = await parent.exited;
        expect(status).not.toBe(0);
        if (signal !== "SIGKILL") expect(status).toBe(2);
        const deadline = Date.now() + 5_000;
        while (alive() && Date.now() < deadline) await Bun.sleep(25);
        expect(alive()).toBe(false);
        expect(await errors).toBe("");
      } finally {
        clearTimeout(timeout);
        reader.releaseLock();
        if (parent.exitCode === null) { parent.kill("SIGKILL"); await parent.exited; }
        if (alive() && workerPid !== undefined) process.kill(workerPid, "SIGKILL");
        await errors;
      }
    }
  } finally { await rm(project, { recursive: true, force: true }); }
}, 30_000);
