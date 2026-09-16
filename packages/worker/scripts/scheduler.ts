import { createHash } from "node:crypto";

export function roleNames(projectRef: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(projectRef)) throw new Error("PGFLOW_PROJECT_INVALID");
  const key = createHash("sha256").update(projectRef).digest("hex").slice(0, 20);
  return { owner: `scw_owner_${key}`, worker: `scw_worker_${key}`, recovery: `scw_recovery_${key}`, job: `scw_recover_${key}` };
}

export function renderSchedule(projectRef: string, database: string, socket?: string): string {
  const roles = roleNames(projectRef);
  if (!/^[a-zA-Z0-9_-]{1,63}$/.test(database)) throw new Error("PGFLOW_DATABASE_INVALID");
  if (socket !== undefined && !/^\/[a-zA-Z0-9_/-]+$/.test(socket)) throw new Error("PGFLOW_CRON_SOCKET_INVALID");
  const command = `DO $job$ BEGIN SET LOCAL ROLE ${roles.recovery}; PERFORM supacloud_worker.recover('${projectRef}'); END $job$;`;
  const literal = command.replaceAll("'", "''");
  return `\\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('supacloud-pgflow-scheduler',0));
DO $check$
BEGIN
  IF current_database() IS DISTINCT FROM current_setting('cron.database_name',true)
    OR current_setting('cron.launch_active_jobs',true) IS DISTINCT FROM 'on'
    OR to_regprocedure('cron.schedule_in_database(text,text,text,text,text,boolean)') IS NULL THEN
    RAISE EXCEPTION 'PGFLOW_CRON_DATABASE_REQUIRED';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${roles.recovery}'
    AND NOT rolsuper AND NOT rolcanlogin AND NOT rolcreaterole AND NOT rolcreatedb) THEN
    RAISE EXCEPTION 'PGFLOW_RECOVERY_ROLE_REQUIRED';
  END IF;
  IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='${roles.job}' AND
    (database<>'${database}' OR username<>current_user OR command<>'${literal}')) THEN
    RAISE EXCEPTION 'PGFLOW_SCHEDULER_BINDING_CONFLICT';
  END IF;
END $check$;
SELECT cron.schedule_in_database('${roles.job}','15 seconds','${literal}','${database}',current_user,true);
${socket ? `UPDATE cron.job SET nodename='${socket}' WHERE jobname='${roles.job}' AND username=current_user;` : ""}
COMMIT;
`;
}
