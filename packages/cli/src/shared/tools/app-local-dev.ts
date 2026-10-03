import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface LocalDevOptions {
  root: string;
  profile?: "fast" | "integration";
  databaseUrl?: string;
  signal?: AbortSignal;
  onOutput?: (text: string) => void;
}

export function localDatabaseUrl(value: string | undefined): string {
  try {
    if (!value || /[\x00-\x20\x7f]/.test(value)) throw new Error();
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol)
      || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.pathname.length <= 1 || url.search || url.hash) throw new Error();
    return value;
  } catch {
    throw new Error("Integration requires an explicit loopback PostgreSQL URL with a database name and no query or fragment");
  }
}

async function probeDatabase(url: string): Promise<void> {
  if (!process.versions.bun) throw new Error("Integration preflight requires the Bun CLI runtime");
  const { SQL } = Bun;
  let database: import("bun").SQL | undefined;
  try {
    database = new SQL(url, { max: 1, connectionTimeout: 5 });
    const query = database`SELECT current_database() AS name,
      r.rolsuper AS superuser, r.rolbypassrls AS bypass_rls
      FROM pg_roles r WHERE r.rolname = current_user`;
    const timeout = setTimeout(() => query.cancel(), 5000);
    let rows: unknown;
    try { rows = await query; }
    finally { clearTimeout(timeout); }
    const expected = decodeURIComponent(new URL(url).pathname.slice(1));
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error();
    const row: unknown = rows[0];
    if (!row || typeof row !== "object" || !("name" in row) || row.name !== expected
      || !("superuser" in row) || row.superuser !== false
      || !("bypass_rls" in row) || row.bypass_rls !== false) throw new Error();
  } catch {
    throw new Error("Integration database verification failed; check connectivity, database identity and non-privileged application role");
  } finally {
    await database?.close({ timeout: 1 }).catch(() => {
      throw new Error("Integration database cleanup failed");
    });
  }
}

/** Launch the project's one dev loop; do not add another compiler watcher. */
export async function runLocalDevelopment(options: LocalDevOptions) {
  const root = resolve(options.root);
  const profile = options.profile ?? "fast";
  if (profile !== "fast" && profile !== "integration") throw new Error("Unknown development profile");
  if (["production", "staging"].includes(process.env.APP_ENV ?? "")
    || process.env.SUPACLOUD_ENV === "production") {
    throw new Error("Local development refuses production or staging environment selectors");
  }
  const script = profile === "integration" ? "dev:integration" : "dev";
  const manifest: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const scripts = manifest && typeof manifest === "object" && "scripts" in manifest
    ? manifest.scripts : undefined;
  const command: unknown = scripts && typeof scripts === "object" ? Reflect.get(scripts, script) : undefined;
  if (typeof command !== "string" || !command.trim()) {
    throw new Error(`Project must declare ${script}; use app watch for compile-only inspection`);
  }
  let databaseUrl: string | undefined;
  if (profile === "integration") {
    databaseUrl = localDatabaseUrl(options.databaseUrl ?? process.env.SUPACLOUD_DEV_DATABASE_URL);
  } else if (options.databaseUrl !== undefined) {
    throw new Error("A database URL requires the integration profile");
  }
  if (options.signal?.aborted) return { profile, script, exitCode: 0, state: "stopped" as const };
  if (databaseUrl) await probeDatabase(databaseUrl);
  if (options.signal?.aborted) return { profile, script, exitCode: 0, state: "stopped" as const };
  const env: NodeJS.ProcessEnv = {
    ...process.env, APP_ENV: "development", SUPACLOUD_ENV: "test", SUPACLOUD_DEV_PROFILE: profile,
  };
  // Fast mode must not accidentally inherit an integration binding.
  delete env.SUPACLOUD_DEV_DATABASE_URL;
  if (databaseUrl) env.SUPACLOUD_DEV_DATABASE_URL = databaseUrl;
  const executable = process.versions.bun ? process.execPath : "bun";
  const child = spawn(executable, ["--no-env-file", "run", script], {
    cwd: root, env, detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outputError: { error: unknown } | undefined;
  let stopping = false;
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
    }
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    kill("SIGTERM");
    timer = setTimeout(() => kill("SIGKILL"), 1500);
  };
  const output = (chunk: Buffer) => {
    try { options.onOutput?.(chunk.toString("utf8")); }
    catch (error) { outputError = { error }; stop(); }
  };
  child.stdout.on("data", output);
  child.stderr.on("data", output);
  options.signal?.addEventListener("abort", stop, { once: true });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (options.signal?.aborted) stop();
  try {
    const exitCode = await new Promise<number>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", code => resolveExit(stopping ? 0 : code ?? 1));
    });
    if (outputError) throw outputError.error;
    return { profile, script, exitCode, state: "stopped" as const };
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
