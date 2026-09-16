import { loadMigrations, renderInstall } from "./migrations.js";
import { renderRoles, renderQueueGrants } from "./roles.js";
import { renderSchedule } from "./scheduler.js";

const project = process.env.SUPACLOUD_PROJECT_REF ?? "";
const database = process.env.PGDATABASE ?? "";
const profile = process.env.PGFLOW_PROFILE ?? "dedicated";
if (profile !== "shared" && profile !== "dedicated") throw new Error("PGFLOW_PROFILE_INVALID");
const action = process.env.PGFLOW_INSTALL_ACTION ?? "engine";
const script = action === "roles" ? renderRoles(project)
  : action === "queue-grants" ? renderQueueGrants(project)
  : action === "schedule" ? renderSchedule(project, process.env.PGFLOW_TARGET_DATABASE ?? "", process.env.PGFLOW_CRON_SOCKET)
  : action === "engine" ? renderInstall(await loadMigrations(profile), project, database, profile)
  : (() => { throw new Error("PGFLOW_INSTALL_ACTION_INVALID"); })();
if (process.argv[2] === "--print") {
  process.stdout.write(script);
} else if (process.argv[2] === "--apply") {
  // Use libpq environment / password file, never place credentials in command arguments.
  const child = Bun.spawn(["psql", "-X", "--no-password"], {
    stdin: new Blob([script]),
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
} else {
  throw new Error(
    "Specify --print or --apply and bind SUPACLOUD_PROJECT_REF / PGDATABASE",
  );
}
