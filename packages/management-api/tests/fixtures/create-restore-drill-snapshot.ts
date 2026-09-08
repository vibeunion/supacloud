import { mkdir, readdir, readFile, lstat, unlink, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { encryptSecretWithKey } from "../../src/utils/secret-crypto-core";
import { COMPONENTS, sha256, signDrillDocument, type RestoreFile, type RestoreSnapshot } from "../../src/services/restore-drill-contract";

// 只在专用临时容器中生成合成数据，不能连接现有项目或外部数据库。
const [kind, output] = process.argv.slice(2);
if (!["logical-full", "pgbackrest"].includes(kind ?? "") || output !== "/tmp/drill-fixture/backup") throw new Error("Invalid fixture target");
const source = "/tmp/supacloud-drill-source";
const socket = "/tmp/supacloud-drill-socket";
const environment = { ...process.env, PGHOST: socket, PGPORT: "55431", PGUSER: "postgres" };
async function command(cmd: string[]) {
  const child = Bun.spawn(cmd, { env: environment, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`Fixture command ${cmd[0]} failed: ${err}`);
  return out.trim();
}
const sql = (value: string, database = "project_fixture") =>
  command(["psql", "-X", "-Atq", "-v", "ON_ERROR_STOP=1", "-d", database, "-c", value]);
await mkdir(output, { recursive: true });
for (const component of COMPONENTS) await mkdir(join(output, component));
await mkdir(socket);
await command(["initdb", "-D", source, "-U", "postgres", "--auth=trust", "--no-locale", "--encoding=UTF8"]);
if (kind === "pgbackrest") {
  await mkdir(join(output, "database/repo"));
  await Bun.write("/tmp/drill-pgbackrest.conf", `[global]\nrepo1-path=${output}/database/repo\nrepo1-retention-full=1\nlog-level-console=error\nstart-fast=y\n[fixture]\npg1-path=${source}\npg1-socket-path=${socket}\npg1-port=55431\npg1-user=postgres\n`);
  await appendFile(join(source, "postgresql.conf"),
    "\narchive_mode=on\narchive_command='pgbackrest --config=/tmp/drill-pgbackrest.conf --stanza=fixture archive-push %p'\n");
}
await command(["pg_ctl", "-D", source, "-l", "/tmp/drill-source.log", "-w", "-o", `-p 55431 -k ${socket} -h 127.0.0.1`, "start"]);
try {
  const snapshotId = crypto.randomUUID();
  const point = new Date().toISOString();
  await command(["createdb", "project_fixture"]);
  await sql(`
    CREATE ROLE authenticated;
    CREATE TABLE documents (id integer PRIMARY KEY, tenant text NOT NULL);
    INSERT INTO documents VALUES (1, 'tenant_a'), (2, 'tenant_b');
    ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
    GRANT SELECT ON documents TO authenticated;
    CREATE POLICY tenant_policy ON documents USING (tenant = current_setting('request.jwt.claims', true)::jsonb->>'tenant');
    CREATE SCHEMA pgmq;
    CREATE TABLE pgmq.q_work (msg_id bigint, message jsonb);
    INSERT INTO pgmq.q_work VALUES (1, '{"kind":"fixture"}');
    CREATE TABLE restore_marker (snapshot_id text, recovered_through timestamptz);
    INSERT INTO restore_marker VALUES ('${snapshotId}', '${point}');
    CREATE TABLE recovery_noise (id integer);
  `);
  const database: RestoreSnapshot["database"] = { kind: kind as "logical-full" | "pgbackrest", name: "project_fixture", admin_role: "postgres", major: 18 };
  if (kind === "logical-full") {
    await command(["pg_dumpall", "--roles-only", "-f", join(output, "database/globals.sql")]);
    await command(["pg_dump", "--format=custom", "-d", "project_fixture", "-f", join(output, "database/database.dump")]);
  } else {
    await command(["pgbackrest", "--config=/tmp/drill-pgbackrest.conf", "--stanza=fixture", "stanza-create"]);
    await command(["pgbackrest", "--config=/tmp/drill-pgbackrest.conf", "--stanza=fixture", "--type=full", "backup"]);
    const inventory = JSON.parse(await command(["pgbackrest", "--config=/tmp/drill-pgbackrest.conf", "--stanza=fixture", "--output=json", "info"]));
    database.stanza = "fixture";
    database.backup_set = inventory[0].backup.at(-1).label;
    database.recovery_target = new Date().toISOString();
    await Bun.sleep(30);
    await sql("INSERT INTO recovery_noise VALUES (1)");
    await sql("SELECT pg_switch_wal()");
    await command(["pgbackrest", "--config=/tmp/drill-pgbackrest.conf", "--stanza=fixture", "check"]);
  }
  await command(["pg_ctl", "-D", source, "-m", "fast", "-w", "stop"]);
  await Bun.write(join(output, "objects/fixture.txt"), "restored-object");
  await Bun.write(join(output, "runtime/check.js"), 'export default () => new Response("restore-ok");\n');
  await Bun.write(join(output, "runtime/check.config.json"), JSON.stringify({ verify_jwt: true }));
  const encryptionKey = process.env.SUPACLOUD_RESTORE_ENCRYPTION_KEY!;
  await Bun.write(join(output, "secrets/runtime-env.enc"), encryptSecretWithKey(JSON.stringify({
    snapshot_id: snapshotId, project_ref: "drillfixture",
    values: { SUPACLOUD_AUTH_RUNTIME_MODE: "local", SUPABASE_SERVICE_ROLE_KEY: "synthetic-drill-service-role" },
  }), encryptionKey));
  const files: RestoreFile[] = [];
  async function inventory(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relative = `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink() && kind === "pgbackrest" && entry.name === "latest") {
        await unlink(path); continue;
      }
      if (entry.isDirectory()) await inventory(path, relative);
      else {
        const bytes = await readFile(path);
        if (!(await lstat(path)).isFile()) throw new Error("Unsupported fixture inventory entry");
        files.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  for (const component of COMPONENTS) await inventory(join(output, component), component);
  const snapshot: RestoreSnapshot = {
    schema: "supacloud.project-restore-snapshot.v1", snapshot_id: snapshotId, project_ref: "drillfixture",
    incident_at: new Date().toISOString(), recovery_points: Object.fromEntries(COMPONENTS.map((component) => [component, point])) as RestoreSnapshot["recovery_points"],
    database, files, database_env_keys: [],
    sql_checks: [
      { name: "tenant_a_visible", category: "permissions", role: "authenticated", claims: { tenant: "tenant_a" }, query: "SELECT id FROM documents ORDER BY id", expected: [{ id: 1 }] },
      { name: "foreign_tenant_empty", category: "permissions", role: "authenticated", claims: { tenant: "tenant_c" }, query: "SELECT id FROM documents ORDER BY id", expected: [] },
      { name: "queue_fixture", category: "queues", role: "postgres", query: "SELECT msg_id, message FROM pgmq.q_work ORDER BY msg_id", expected: [{ msg_id: 1, message: { kind: "fixture" } }] },
      { name: "business_fixture", category: "business", role: "postgres", query: "SELECT count(*)::integer AS count FROM documents", expected: [{ count: 2 }] },
    ],
    marker_query: `SELECT snapshot_id, to_char(recovered_through AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recovered_through FROM restore_marker`,
    http_checks: [
      { slug: "check", path: "/", auth: "anonymous", status: 401, sha256: sha256(JSON.stringify({ msg: "Invalid JWT" })) },
      { slug: "check", path: "/", auth: "service_role", status: 200, sha256: sha256("restore-ok") },
    ],
    max_rpo_ms: 600_000, max_rto_ms: 120_000, signature: "",
  };
  if (kind === "pgbackrest") snapshot.sql_checks.push({
    name: "after_target_transaction_absent", category: "business", role: "postgres",
    query: "SELECT count(*)::integer AS count FROM recovery_noise", expected: [{ count: 0 }],
  });
  snapshot.signature = signDrillDocument(snapshot as unknown as Record<string, unknown>, process.env.SUPACLOUD_SNAPSHOT_SIGNING_KEY!);
  await Bun.write(join(output, "manifest.json"), JSON.stringify(snapshot) + "\n");
  console.log(JSON.stringify({ snapshot_id: snapshotId, method: kind, files: files.length }));
} finally {
  await command(["pg_ctl", "-D", source, "-m", "immediate", "-w", "stop"]).catch(() => {});
}
