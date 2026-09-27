import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStarterLite } from "./starter-lite";

for (const profile of ["pglite", "native"] as const) {
  const postgresBin = profile === "native" ? process.env.SUPACLOUD_STARTER_POSTGRES_BIN : undefined;
  const lifecycleTest = profile === "native" && !postgresBin ? test.skip : test;

  lifecycleTest(`${profile} Lite fixture preserves HTTP identity and database state across a shared restart`, async () => {
    const root = await mkdtemp(join(tmpdir(), "starter-lite-lifecycle-"));
    const lite = await startStarterLite(root, new AbortController().signal, postgresBin);
    try {
      const endpoint = lite.storage;
      expect((await fetch(new URL("/health", endpoint.url))).status).toBe(200);
      await lite.exec("CREATE TABLE restart_evidence (id integer PRIMARY KEY); INSERT INTO restart_evidence VALUES (1)");
      const restarting = lite.restart();
      expect(lite.restart()).toBe(restarting);
      await restarting;
      expect(lite.storage).toEqual(endpoint);
      expect(await lite.transaction((tx) => tx.query("SELECT id FROM restart_evidence"))).toEqual([{ id: 1 }]);
      const closing = lite.close();
      expect(lite.close()).toBe(closing);
      await closing;
      expect(() => lite.storage).toThrow("closing");
      expect(() => lite.restart()).toThrow("closing");
      await expect(fetch(new URL("/health", endpoint.url))).rejects.toThrow();
    } finally {
      await lite.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  lifecycleTest(`${profile} Lite fixture abort during restart releases the backend and HTTP listener`, async () => {
    const root = await mkdtemp(join(tmpdir(), "starter-lite-abort-"));
    const controller = new AbortController();
    const lite = await startStarterLite(root, controller.signal, postgresBin);
    const endpoint = lite.storage.url;
    try {
      const restarting = lite.restart();
      const outcome = restarting.then(() => null, (error: unknown) => error);
      controller.abort(new Error("Cancelled fixture"));
      expect(await outcome).toEqual(new Error("Cancelled fixture"));
      await lite.close();
      await expect(fetch(new URL("/health", endpoint))).rejects.toThrow();
    } finally {
      await lite.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
}

test("Lite fixture refuses a cancelled startup before creating resources", async () => {
  await expect(startStarterLite("/unused-cancelled-starter-fixture",
    AbortSignal.abort(new Error("Cancelled before startup")))).rejects.toThrow("Cancelled before startup");
});
