import { createHash } from "node:crypto";

export async function renderAdmissionInstall(projectRef: string): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(projectRef) || /[\r\n]/.test(projectRef))
    throw new Error("WORKER_ADMISSION_PROJECT_INVALID");
  const sql = await Bun.file(new URL("../sql/002-admission.sql", import.meta.url)).text();
  const hash = createHash("sha256").update(sql).digest("hex");
  return `BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('supacloud-worker-admission',0));
DO $binding$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM supacloud_worker.installation WHERE project_ref='${projectRef}') THEN
    RAISE EXCEPTION 'WORKER_ADMISSION_PROJECT_INVALID';
  END IF;
END $binding$;
CREATE TABLE IF NOT EXISTS supacloud_worker.admission_installation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  sha256 text NOT NULL
);
REVOKE ALL ON supacloud_worker.admission_installation FROM PUBLIC;
DO $checksum$ BEGIN
  IF EXISTS(SELECT 1 FROM supacloud_worker.admission_installation WHERE sha256<>'${hash}') THEN
    RAISE EXCEPTION 'WORKER_ADMISSION_MIGRATION_REQUIRED';
  END IF;
END $checksum$;
${sql}
INSERT INTO supacloud_worker.admission_installation VALUES(true,'${hash}') ON CONFLICT DO NOTHING;
COMMIT;`;
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error();
    console.log(await renderAdmissionInstall(process.argv[2]!));
  } catch { console.error("WORKER_ADMISSION_PROJECT_INVALID"); process.exitCode = 1; }
}
