import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = process.env.SUPACLOUD_STARTER_POSTGRES_BIN;
const nativeTest = bin ? test : test.skip;
const helper = new URL("./starter-postgres.ts", import.meta.url).href;

for (const phase of ["startup", "query"] as const) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    nativeTest(`temporary PostgreSQL cleans up on ${signal} during ${phase}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "starter-interruption-"));
      const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `
        import { startStarterPostgres } from ${JSON.stringify(helper)};
        import { writeFile } from "node:fs/promises";
        const controller = new AbortController();
        const interrupt = () => controller.abort();
        process.once("SIGINT", interrupt);
        process.once("SIGTERM", interrupt);
        let db;
        try {
          db = await startStarterPostgres(${JSON.stringify(bin)}, controller.signal);
          const pending = db.exec("SELECT pg_sleep(30)").then(
            () => ({ ok: true }), error => ({ ok: false, error }),
          );
          let observed = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            const rows = await db.transaction(tx => tx.query(
              "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE state='active' AND query='SELECT pg_sleep(30)') AS running",
            ));
            if (rows[0]?.running === true) { observed = true; break; }
            await Bun.sleep(10);
          }
          if (!observed) throw new Error("Long query was not observed running");
          await writeFile(${JSON.stringify(join(root, "ready"))}, "ready");
          const outcome = await pending;
          if (!outcome.ok) throw outcome.error;
          throw new Error("Expected interruption");
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        } finally {
          await db?.close();
          await db?.close();
        }
      `], {
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: root },
        stdout: "pipe", stderr: "pipe",
      });
      const output = new Response(child.stderr).text();
      const stdout = new Response(child.stdout).text();
      const timer = setTimeout(() => child.kill("SIGTERM"), 15_000);
      let postmaster: number | undefined;
      try {
        const until = Date.now() + 10_000;
        let ready = false;
        while (Date.now() < until && child.exitCode === null) {
          const cluster = (await readdir(root)).find((name) => name.startsWith("supacloud-starter-pg-"));
          const marker = phase === "query" ? join(root, "ready") : cluster ? join(root, cluster, "data") : undefined;
          if (marker && await stat(marker).then(() => true, (error: unknown) => {
            if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
            throw error;
          })) {
            if (phase === "query" && cluster) {
              postmaster = Number((await readFile(join(root, cluster, "data/postmaster.pid"), "utf8")).split("\n")[0]);
            }
            ready = true;
            break;
          }
          await Bun.sleep(5);
        }
        if (!ready && child.exitCode !== null) throw new Error("Fixture exited before readiness: " + await output);
        expect(ready).toBe(true);
        child.kill(signal);
        const code = await child.exited;
        if (code !== 0) throw new Error(`Interrupted fixture exited with ${code}: ${await output}`);
        expect(code).toBe(0);
        expect(await output).toBe("");
        if (postmaster !== undefined) {
          expect(Number.isSafeInteger(postmaster) && postmaster > 0).toBe(true);
          expect(() => process.kill(postmaster!, 0)).toThrow();
        }
        expect((await readdir(root)).filter((name) => name.startsWith("supacloud-starter-pg-"))).toEqual([]);
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
        await Promise.all([stdout, output]);
        const remaining = (await readdir(root)).filter((name) => name.startsWith("supacloud-starter-pg-"));
        // Preserve evidence rather than deleting a cluster after failed cleanup.
        if (remaining.length === 0) await rm(root, { recursive: true, force: true });
      }
    }, 30_000);
  }
}
