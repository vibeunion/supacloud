import { SQL } from "bun";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CommandDatabase } from "../../packages/db/src/command-adapter";

export interface StarterPostgres extends CommandDatabase {
  exec(sql: string): Promise<void>;
  restart(): Promise<void>;
  close(): Promise<void>;
  /** Ephemeral owned-cluster credentials for detached acceptance processes; never log. */
  withConnection<T>(run: (url: string) => Promise<T>): Promise<T>;
}

/** A new password-protected local cluster only; never accepts a database URL. */
export async function startStarterPostgres(binDirectory: string, signal?: AbortSignal): Promise<StarterPostgres> {
  signal?.throwIfAborted();
  const bin = resolve(binDirectory);
  const root = await mkdtemp(join(tmpdir(), "supacloud-starter-pg-"));
  const cluster = join(root, "data");
  const password = crypto.randomUUID();
  const passwordFile = join(root, "password");
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) });
  const port = reservation.port;
  reservation.stop(true);
  assert.ok(port);
  const env = {
    ...Object.fromEntries(["PATH", "HOME", "TMPDIR"].flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]!]])),
    LC_ALL: "C",
  };
  let started = false;
  let sql: SQL | undefined;
  let closing: Promise<void> | undefined;
  let restarting: Promise<void> | undefined;
  async function command(name: string, args: string[]): Promise<void> {
    const child = Bun.spawn([join(bin, name), ...args], { env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 30_000);
    try {
      const [code, out, err] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      assert.equal(code, 0, `${name} failed: ${(out + err).replaceAll(password, "[REDACTED]")}`);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) { child.kill(); await child.exited; }
    }
  }
  async function connect() {
    sql = new SQL({
      hostname: "127.0.0.1", port, username: "starter_test", password, database: "postgres",
      max: 12, connectionTimeout: 5,
    });
    const rows: unknown = await sql.unsafe<unknown>("SHOW data_directory");
    assert.ok(Array.isArray(rows) && rows.length === 1);
    const row: unknown = rows[0];
    assert.ok(row !== null && typeof row === "object" && "data_directory" in row);
    // macOS may canonicalize /var to /private/var.
    assert.equal(typeof row.data_directory, "string");
    assert.equal(await realpath(row.data_directory as string), await realpath(cluster));
  }
  async function start() {
    signal?.throwIfAborted();
    try {
      await command("pg_ctl", [
        "-D", cluster, "-l", join(root, "postgres.log"), "-w", "-t", "20",
        "-o", `-h 127.0.0.1 -p ${port} -k ''`, "start",
      ]);
    } catch (error) {
      const log = await readFile(join(root, "postgres.log"), "utf8").catch((failure: unknown) => {
        if (failure !== null && typeof failure === "object" && "code" in failure && failure.code === "ENOENT") return "";
        throw failure;
      });
      throw new Error("Temporary PostgreSQL startup failed: " + log.replaceAll(password, "[REDACTED]"), { cause: error });
    }
    started = true;
    signal?.throwIfAborted();
    await connect();
    signal?.throwIfAborted();
  }
  async function stop() {
    // Stop the server before draining its pool: cancellation can otherwise wait
    // on a running query and leave the detached postmaster alive.
    const pid = await readFile(join(cluster, "postmaster.pid"), "utf8").catch((error: unknown) => {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (started || pid !== null) {
      await command("pg_ctl", ["-D", cluster, "-m", "fast", "-w", "-t", "20", "stop"]);
    }
    started = false;
    try { await sql?.close({ timeout: 1 }); }
    finally { sql = undefined; }
  }
  try {
    signal?.throwIfAborted();
    await writeFile(passwordFile, password + "\n", { mode: 0o600 });
    await command("initdb", [
      "-D", cluster, "-U", "starter_test", "--auth=scram-sha-256", "--pwfile", passwordFile,
      "--no-locale", "--encoding=UTF8", "--no-instructions",
    ]);
    await rm(passwordFile);
    await start();
  } catch (error) {
    await stop();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const pool = () => {
    signal?.throwIfAborted();
    assert.ok(sql, "Temporary PostgreSQL is closed");
    return sql;
  };
  function close(): Promise<void> {
    closing ??= (async () => {
      // Restart errors still reach their caller; cleanup waits for the in-flight
      // lifecycle operation so it cannot delete a cluster that is starting.
      if (restarting) await Promise.allSettled([restarting]);
      await stop();
      await rm(root, { recursive: true, force: true });
      signal?.removeEventListener("abort", abort);
    })();
    return closing;
  }
  function abort() {
    // close() retains the failure and the owner's finally awaits it again.
    void close().catch(() => { process.exitCode = 1; });
  }
  signal?.addEventListener("abort", abort, { once: true });
  return {
    async exec(text) { await pool().unsafe(text); },
    async transaction(run) {
      const result = await pool().begin(async (tx) => ({
        value: await run({
          query: async (text, parameters = []) => {
            signal?.throwIfAborted();
            const rows: unknown = await tx.unsafe<unknown>(text, [...parameters]);
            return rows;
          },
        }),
      }));
      return result.value;
    },
    restart() {
      signal?.throwIfAborted();
      assert.ok(!closing, "Temporary PostgreSQL is closing");
      restarting = (async () => { await stop(); await start(); })();
      return restarting;
    },
    close,
    withConnection(run) {
      pool();
      const url = new URL(`postgres://127.0.0.1:${port}/postgres`);
      url.username = "starter_test";
      url.password = password;
      return run(url.href);
    },
  };
}
