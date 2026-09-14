import { SQL } from "bun";

async function docker(...args: string[]): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`Disposable PostgreSQL fixture failed: ${stderr}`);
  return stdout.trim();
}

export async function waitForPostgresFixture(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for disposable PostgreSQL");
    await Bun.sleep(25);
  }
}

export async function withNativePostgres(
  run: (database: SQL, url: string, name: string) => Promise<void>,
  options: { logicalReplication?: boolean; image?: string } = {},
): Promise<void> {
  const name = `supacloud-native-test-${crypto.randomUUID()}`;
  let database: SQL | undefined;
  await docker("run", "--detach", "--rm", "--name", name,
    "--publish", "127.0.0.1::5432",
    "--env", "POSTGRES_USER=fixture", "--env", "POSTGRES_DB=fixture",
    "--env", "POSTGRES_PASSWORD=synthetic", "--env", "POSTGRES_HOST_AUTH_METHOD=scram-sha-256",
    options.image ?? "supacloud-graphql-test:pg18",
    ...(options.logicalReplication ? ["postgres", "-c", "wal_level=logical"] : []));
  try {
    await waitForPostgresFixture(async () => {
      try {
        await docker("exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "fixture", "-d", "fixture");
        return true;
      } catch { return false; }
    });
    const mapping = await docker("port", name, "5432/tcp");
    const port = /^127\.0\.0\.1:(\d+)$/.exec(mapping)?.[1];
    if (!port) throw new Error("Expected loopback-only fixture port");
    const url = `postgres://fixture:synthetic@127.0.0.1:${port}/fixture`;
    database = new SQL(url, { max: 5, connectionTimeout: 3 });
    await run(database, url, name);
  } finally {
    try {
      await database?.close({ timeout: 1 });
    } finally {
      await docker("rm", "--force", name);
    }
  }
}
