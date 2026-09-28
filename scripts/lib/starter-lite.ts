import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import type { CommandDatabase } from "../../packages/db/src/command-adapter";
import type { DbEngine } from "../../packages/supacloud-lite/src/runtime/db/engine";
import type { BackendConfig, StorageDriver } from "../../packages/supacloud-lite/src/runtime/types";
import type { ExternalIdentityVerifier, VerifiedSupAuthContext } from "../../packages/supacloud-lite/src/runtime/identity";

interface Backend {
  db: { engine: DbEngine };
  fetch: typeof fetch;
  anonKey: string;
  serviceRoleKey: string;
  close(): Promise<void>;
}

export interface StarterLite extends CommandDatabase {
  exec(sql: string): Promise<void>;
  restart(): Promise<void>;
  close(): Promise<void>;
  configureIdentity(options: {
    context(request: Request): Promise<VerifiedSupAuthContext>;
    resolveLocalSubject(identity: VerifiedSupAuthContext["identity"]): Promise<string | null>;
  }): void;
  readonly storage: { url: string; anonKey: string; serviceRoleKey: string };
  workerConnection?(): Promise<{ socketPath: string; database: string; username: string }>;
}

/** Real loopback HTTP, private filesystem objects and an explicitly owned database. */
export async function startStarterLite(root: string, signal: AbortSignal, postgresBin?: string): Promise<StarterLite> {
  signal.throwIfAborted();
  const runtime: { createBackend(config: BackendConfig): Promise<Backend> } =
    await import(new URL("../../packages/supacloud-lite/src/runtime/index.ts", import.meta.url).href);
  const storage: { FsStorageDriver: new (root: string) => StorageDriver } =
    await import(new URL("../../packages/supacloud-lite/src/runtime/node/fs-driver.ts", import.meta.url).href);
  const identities: {
    createSupAuthLiteIdentity(options: Parameters<StarterLite["configureIdentity"]>[0] & { projectId: string }): ExternalIdentityVerifier;
  } = await import(new URL("../../packages/supacloud-lite/src/runtime/identity.ts", import.meta.url).href);
  const native: { createNativeEngine(options: { dataDir: string; installDir: string }): Promise<DbEngine> } | undefined = postgresBin
    ? await import(new URL("../../packages/supacloud-lite/src/runtime/node/native/engine.ts", import.meta.url).href)
    : undefined;
  const jwtSecret = crypto.randomUUID() + crypto.randomUUID();
  const vaultKey = crypto.randomUUID() + crypto.randomUUID();
  let verifier: ExternalIdentityVerifier | undefined;
  let backend: Backend | undefined;
  let restarting: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const open = async () => {
    signal.throwIfAborted();
    backend = await runtime.createBackend({
      ...(native && postgresBin
        ? { engine: await native.createNativeEngine({ dataDir: join(root, "native"), installDir: dirname(postgresBin) }) }
        : { dataDir: join(root, "pglite") }),
      storageDriver: new storage.FsStorageDriver(join(root, "objects")),
      jwtSecret, vaultKey, host: "127.0.0.1", startRuntimeServices: false, log: () => {},
      async externalIdentity(request) {
        assert.ok(verifier, "The fixture identity verifier is not configured");
        return verifier(request);
      },
    });
    signal.throwIfAborted();
  };
  const current = () => {
    signal.throwIfAborted();
    assert.ok(!closing, "The fixture backend is closing");
    assert.ok(backend, "The fixture backend is closed");
    return backend;
  };
  let server: ReturnType<typeof Bun.serve> | undefined;
  const close = () => {
    closing ??= (async () => {
      if (restarting) await Promise.allSettled([restarting]);
      server?.stop(true);
      await backend?.close();
      backend = undefined;
      signal.removeEventListener("abort", abort);
    })();
    return closing;
  };
  const abort = () => { void close().catch(() => { process.exitCode = 1; }); };
  try {
    await open();
    server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: (request) => backend ? backend.fetch(request) : new Response(null, { status: 503 }),
    });
    signal.addEventListener("abort", abort, { once: true });
  } catch (error) {
    await close();
    throw error;
  }
  return {
    ...(native ? {
      async workerConnection() {
        const directory = (await current().db.engine.query("SHOW unix_socket_directories")).rows[0]?.unix_socket_directories;
        const port = (await current().db.engine.query("SHOW port")).rows[0]?.port;
        assert.ok(typeof directory === "string" && directory.startsWith("/") && !directory.includes(","));
        assert.ok(typeof port === "string" && /^\d+$/.test(port));
        return { socketPath: join(directory, ".s.PGSQL." + port), database: "postgres", username: "postgres" };
      },
    } : {}),
    get storage() {
      assert.ok(server);
      return { url: server.url.toString(), anonKey: current().anonKey, serviceRoleKey: current().serviceRoleKey };
    },
    configureIdentity(options) {
      verifier = identities.createSupAuthLiteIdentity({ ...options, projectId: "starter-test" });
    },
    exec: (sql) => current().db.engine.exec(sql),
    transaction: (run) => current().db.engine.transaction((tx) => run({
      query: async (sql, parameters = []) => (await tx.query(sql, [...parameters])).rows,
    })),
    restart() {
      signal.throwIfAborted();
      assert.ok(!closing, "The fixture backend is closing");
      if (restarting) return restarting;
      restarting = (async () => {
        await backend?.close();
        backend = undefined;
        await open();
      })().finally(() => { restarting = undefined; });
      return restarting;
    },
    close,
  };
}
