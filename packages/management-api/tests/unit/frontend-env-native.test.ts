// @supacloud-test-isolate
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../src/config";
import { FrontendService } from "../../src/services/frontend.service";
import { createFrontendDeploymentLock } from "../../src/services/frontend-deployment-lock";
import { createFrontendEnvironmentRevision, FrontendEnvironmentConflictError } from "../../src/utils/frontend-environment-revision";
import { createFrontendConfigurationRevision, FrontendConfigurationConflictError } from "../../src/utils/frontend-configuration-revision";
import { withNativePostgres, waitForPostgresFixture } from "../helpers/native-postgres";

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
  "independent processes fence stale environment writes with a real PostgreSQL advisory lock",
  async () => withNativePostgres(async (database, url) => {
    const baseDir = await mkdtemp(path.join(tmpdir(), "supacloud-env-native-"));
    const previousKey = config.secretsEncryptionKey;
    const fixtureKey = "synthetic-frontend-environment-native-key";
    config.secretsEncryptionKey = fixtureKey;
    const lock = createFrontendDeploymentLock(database);
    const service = new FrontendService(baseDir, lock);
    try {
      const deployment = await service.createDeployment("proj123", {
        name: "native", framework: "static", env_vars: { TOKEN: "initial" },
      });
      const revision = createFrontendEnvironmentRevision(deployment);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let nested: Promise<void> | undefined;
      let parentSettled = false;
      const held = lock("proj123", deployment.id, async () => {
        nested = lock("proj123", deployment.id, async () => {
          entered.resolve();
          await release.promise;
        });
        void nested.catch(() => {});
      });
      const settlement = held.then(() => { parentSettled = true; }, () => { parentSettled = true; });
      const workerPath = fileURLToPath(new URL("../helpers/frontend-env-worker.ts", import.meta.url));
      const spawnWorker = (value: string) => Bun.spawn({
        cmd: [process.execPath, workerPath, url, baseDir, deployment.id, revision, value],
        env: { ...process.env, SECRETS_ENCRYPTION_KEY: fixtureKey },
        stdout: "pipe", stderr: "pipe",
      });
      await entered.promise;
      const workers = [spawnWorker("first"), spawnWorker("second")];
      const outputs = Promise.all(workers.map(async child => {
        const [code, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        return { code, stdout, stderr };
      }));
      try {
        await waitForPostgresFixture(async () => {
          const rows = await database<{ waiting: number }[]>`
            SELECT count(*)::integer AS waiting FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
          `;
          return rows[0]?.waiting === 2;
        });
        expect(parentSettled).toBe(false);
        expect(workers.every(child => child.exitCode === null)).toBe(true);
        expect((await service.getDeployment("proj123", deployment.id))?.env_vars).toEqual({ TOKEN: "initial" });
        release.resolve();
        await held;
        const results = await outputs;
        const decoded: Array<{ outcome: string; value?: string }> = [];
        for (const result of results) {
          expect(result.code, result.stderr).toBe(0);
          const row: unknown = JSON.parse(result.stdout);
          if (!row || typeof row !== "object" || !("outcome" in row)) throw new Error("Invalid worker receipt");
          if (row.outcome === "conflict") decoded.push({ outcome: "conflict" });
          else if (row.outcome === "saved" && "value" in row && typeof row.value === "string") {
            decoded.push({ outcome: "saved", value: row.value });
          } else throw new Error("Invalid worker outcome");
        }
        expect(decoded.map(row => row.outcome).sort()).toEqual(["conflict", "saved"]);
        const winner = decoded.find(row => row.outcome === "saved");
        expect(["first", "second"]).toContain(winner?.value);
        const stored = await service.getDeployment("proj123", deployment.id);
        expect(stored?.env_vars).toEqual({ TOKEN: winner?.value });
        const filename = path.join(baseDir, "proj123", deployment.id, "deployment.json");
        const before = await readFile(filename, "utf8");
        await expect(service.setEnvVars("proj123", deployment.id, { TOKEN: "stale" }, "replace", revision))
          .rejects.toBeInstanceOf(FrontendEnvironmentConflictError);
        expect(await readFile(filename, "utf8")).toBe(before);
        if (!stored) throw new Error("Missing stored deployment");
        const next = await service.setEnvVars("proj123", deployment.id, { TOKEN: "fresh" }, "replace",
          createFrontendEnvironmentRevision(stored));
        expect(next?.env_vars).toEqual({ TOKEN: "fresh" });
        expect((await service.getDeployment("proj123", deployment.id))?.env_vars).toEqual({ TOKEN: "fresh" });
        const wake = Promise.withResolvers<void>();
        let delayed: Promise<string> | undefined;
        let delayedEntered = false;
        await lock("proj123", deployment.id, async () => {
          delayed = wake.promise.then(() => lock("proj123", deployment.id, async () => {
            delayedEntered = true;
            return "reacquired";
          }));
        });
        const blockingEntered = Promise.withResolvers<void>();
        const blockingRelease = Promise.withResolvers<void>();
        const competingLock = createFrontendDeploymentLock(database);
        const blocking = competingLock("proj123", deployment.id, async () => {
          blockingEntered.resolve();
          await blockingRelease.promise;
        });
        try {
          await blockingEntered.promise;
          wake.resolve();
          await waitForPostgresFixture(async () => {
            const rows = await database<{ waiting: number }[]>`
              SELECT count(*)::integer AS waiting FROM pg_locks
              WHERE locktype = 'advisory' AND NOT granted
            `;
            return rows[0]?.waiting === 1;
          });
          expect(delayedEntered).toBe(false);
          blockingRelease.resolve();
          await blocking;
          expect(await delayed).toBe("reacquired");
          expect(delayedEntered).toBe(true);
        } finally {
          wake.resolve();
          blockingRelease.resolve();
          await Promise.allSettled([blocking, delayed]);
        }
        const locks = await database<{ remaining: number }[]>`
          SELECT count(*)::integer AS remaining FROM pg_locks WHERE locktype = 'advisory'
        `;
        expect(locks[0]?.remaining).toBe(0);
      } finally {
        release.resolve();
        for (const child of workers) if (child.exitCode === null) child.kill();
        await Promise.allSettled([held, nested, settlement, outputs]);
      }
    } finally {
      config.secretsEncryptionKey = previousKey;
      await rm(baseDir, { recursive: true, force: true });
    }
  }), 60_000,
);

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
  "independent configuration writers publish one coherent winner and detect legacy Git changes",
  async () => withNativePostgres(async (database, url) => {
    const baseDir = await mkdtemp(path.join(tmpdir(), "supacloud-config-native-"));
    const previousKey = config.secretsEncryptionKey;
    const fixtureKey = "synthetic-frontend-configuration-native-key";
    config.secretsEncryptionKey = fixtureKey;
    const lock = createFrontendDeploymentLock(database);
    const service = new FrontendService(baseDir, lock);
    try {
      const deployment = await service.createDeployment("proj123", {
        name: "native", framework: "static", env_vars: { TOKEN: "untouched" },
      });
      const revision = createFrontendConfigurationRevision(deployment);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const held = lock("proj123", deployment.id, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const workerPath = fileURLToPath(new URL("../helpers/frontend-env-worker.ts", import.meta.url));
      const workers = ["first", "second"].map(value => Bun.spawn({
        cmd: [process.execPath, workerPath, url, baseDir, deployment.id, revision, value, "configuration"],
        env: { ...process.env, SECRETS_ENCRYPTION_KEY: fixtureKey }, stdout: "pipe", stderr: "pipe",
      }));
      const outputs = Promise.all(workers.map(async child => {
        const [code, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        return { code, stdout, stderr };
      }));
      try {
        await waitForPostgresFixture(async () => {
          const rows = await database<{ waiting: number }[]>`
            SELECT count(*)::integer AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
          `;
          return rows[0]?.waiting === 2;
        });
        expect(workers.every(child => child.exitCode === null)).toBe(true);
        release.resolve();
        await held;
        const outcomes: string[] = [];
        let winner: string | undefined;
        for (const result of await outputs) {
          expect(result.code, result.stderr).toBe(0);
          const row: unknown = JSON.parse(result.stdout);
          if (!row || typeof row !== "object" || !("outcome" in row)) throw new Error("Invalid worker receipt");
          if (row.outcome === "conflict") outcomes.push("conflict");
          else if (row.outcome === "saved" && "value" in row && typeof row.value === "string") {
            outcomes.push("saved");
            winner = row.value;
          } else throw new Error("Invalid worker outcome");
        }
        expect(outcomes.sort()).toEqual(["conflict", "saved"]);
        expect(["first", "second"]).toContain(winner);
        const stored = await service.getDeployment("proj123", deployment.id);
        expect(stored).toMatchObject({
          build_command: winner, git_url: `https://example.com/${winner}.git`, git_branch: winner,
          env_vars: { TOKEN: "untouched" },
        });
        if (!stored) throw new Error("Missing stored deployment");
        const oldRevision = createFrontendConfigurationRevision(stored);
        await service.setGitConfig("proj123", deployment.id, "https://example.com/legacy.git", "legacy");
        const filename = path.join(baseDir, "proj123", deployment.id, "deployment.json");
        const before = await readFile(filename, "utf8");
        const configuration = {
          build_command: "next", output_dir: ".", install_command: "", node_version: "20", health_check_path: "/",
        };
        await expect(service.saveBuildConfiguration("proj123", deployment.id, configuration,
          "https://example.com/next.git", "main", oldRevision)).rejects.toBeInstanceOf(FrontendConfigurationConflictError);
        expect(await readFile(filename, "utf8")).toBe(before);
        const afterLegacy = await service.getDeployment("proj123", deployment.id);
        if (!afterLegacy) throw new Error("Missing legacy update");
        const freshRevision = createFrontendConfigurationRevision(afterLegacy);
        await service.setEnvVars("proj123", deployment.id, { TOKEN: "env-only-change" });
        await service.saveBuildConfiguration("proj123", deployment.id, configuration,
          "https://example.com/next.git", "main", freshRevision);
        expect(await service.getDeployment("proj123", deployment.id)).toMatchObject({
          ...configuration, git_url: "https://example.com/next.git", git_branch: "main",
          env_vars: { TOKEN: "env-only-change" },
        });
        const locks = await database<{ remaining: number }[]>`
          SELECT count(*)::integer AS remaining FROM pg_locks WHERE locktype = 'advisory'
        `;
        expect(locks[0]?.remaining).toBe(0);
      } finally {
        release.resolve();
        for (const child of workers) if (child.exitCode === null) child.kill();
        await Promise.allSettled([held, outputs]);
      }
    } finally {
      config.secretsEncryptionKey = previousKey;
      await rm(baseDir, { recursive: true, force: true });
    }
  }), 60_000,
);
