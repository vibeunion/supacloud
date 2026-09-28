/** Install through the application's normal migration flow, never during a request. */
export const COMMAND_PERSISTENCE_SQL = `
DO $runtime$
BEGIN
  IF to_regprocedure('supacloud_workflows.start_run(uuid,text,text,text,jsonb,integer)') IS NULL
    OR to_regprocedure('supacloud_commands.status(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Install the SupaCloud Commands/Workflow/PGMQ runtime before command persistence';
  END IF;
END
$runtime$;
CREATE SCHEMA IF NOT EXISTS supacloud_commands;
REVOKE ALL ON SCHEMA supacloud_commands FROM PUBLIC;
CREATE TABLE IF NOT EXISTS supacloud_commands.execution_receipts (
  tenant_id text NOT NULL,
  actor_id text NOT NULL,
  command text NOT NULL,
  operation_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('transactional', 'external')),
  input_fingerprint text NOT NULL CHECK (input_fingerprint ~ '^[a-f0-9]{64}$'),
  input_payload text,
  dispatch_key uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  status text NOT NULL CHECK (status IN ('pending', 'unknown', 'confirmed', 'rejected')),
  audit_state text NOT NULL CHECK (audit_state IN ('pending', 'complete')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, actor_id, command, operation_key),
  CHECK ((status = 'confirmed') = (result IS NOT NULL)),
  CONSTRAINT execution_receipts_audit_terminal_check CHECK (
    (audit_state <> 'complete' OR status IN ('confirmed', 'rejected'))
    AND (status <> 'rejected' OR audit_state = 'complete')),
  CONSTRAINT execution_receipts_transactional_check CHECK (
    kind <> 'transactional' OR (status = 'confirmed' AND audit_state = 'complete'))
);
CREATE TABLE IF NOT EXISTS supacloud_commands.execution_audit (
  tenant_id text NOT NULL,
  actor_id text NOT NULL,
  command text NOT NULL,
  operation_key text NOT NULL,
  event text NOT NULL,
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, actor_id, command, operation_key),
  FOREIGN KEY (tenant_id, actor_id, command, operation_key)
    REFERENCES supacloud_commands.execution_receipts (tenant_id, actor_id, command, operation_key)
);
REVOKE ALL ON supacloud_commands.execution_receipts, supacloud_commands.execution_audit FROM PUBLIC;
CREATE OR REPLACE FUNCTION supacloud_commands.protect_terminal_execution()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $terminal$
BEGIN
  IF OLD.status IN ('confirmed','rejected') AND (
    NEW.status IS DISTINCT FROM OLD.status OR NEW.result IS DISTINCT FROM OLD.result
    OR (OLD.audit_state = 'complete' AND NEW.audit_state IS DISTINCT FROM OLD.audit_state)) THEN
    RAISE EXCEPTION 'SUPACLOUD_COMMAND_TERMINAL_RECEIPT';
  END IF;
  RETURN NEW;
END
$terminal$;
CREATE OR REPLACE TRIGGER execution_terminal_guard
BEFORE UPDATE ON supacloud_commands.execution_receipts
FOR EACH ROW EXECUTE FUNCTION supacloud_commands.protect_terminal_execution();

CREATE OR REPLACE FUNCTION supacloud_commands.require_rejection_audit()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $rejection$
BEGIN
  IF NEW.status = 'rejected' AND NOT EXISTS (
    SELECT FROM supacloud_commands.execution_audit a
    WHERE a.tenant_id=NEW.tenant_id AND a.actor_id=NEW.actor_id
      AND a.command=NEW.command AND a.operation_key=NEW.operation_key
  ) THEN
    RAISE EXCEPTION 'SUPACLOUD_COMMAND_REJECTION_AUDIT_REQUIRED';
  END IF;
  RETURN NEW;
END
$rejection$;
DROP TRIGGER IF EXISTS execution_rejection_audit ON supacloud_commands.execution_receipts;
CREATE CONSTRAINT TRIGGER execution_rejection_audit
AFTER INSERT OR UPDATE ON supacloud_commands.execution_receipts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION supacloud_commands.require_rejection_audit();
CREATE OR REPLACE FUNCTION supacloud_commands.enqueue_execution_recovery()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $recovery$
DECLARE submission jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.dispatch_key::text,0));
  SELECT supacloud_commands.snapshot(NEW.dispatch_key,false) INTO submission;
  IF submission IS NOT NULL THEN
    IF submission->>'commandType' IS DISTINCT FROM NEW.command
      OR submission->>'actorId' IS DISTINCT FROM NEW.actor_id
      OR submission->>'tenantId' IS DISTINCT FROM NEW.tenant_id
      OR NEW.operation_key <> NEW.dispatch_key::text THEN
      RAISE EXCEPTION 'SUPACLOUD_COMMAND_IDENTITY_CONFLICT';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.kind = 'external' AND NEW.status <> 'rejected'
    AND (NEW.status <> 'confirmed' OR NEW.audit_state <> 'complete') THEN
    PERFORM supacloud_workflows.start_run(
      NEW.dispatch_key, 'supacloud.command.reconcile', '1', 'reconcile',
      jsonb_build_object('commandId', NEW.dispatch_key, 'tenantId', NEW.tenant_id,
        'actorId', NEW.actor_id, 'command', NEW.command, 'operationId', NEW.operation_key),
      20
    );
  END IF;
  RETURN NEW;
END
$recovery$;
CREATE OR REPLACE TRIGGER execution_recovery_enqueue
AFTER INSERT ON supacloud_commands.execution_receipts
FOR EACH ROW EXECUTE FUNCTION supacloud_commands.enqueue_execution_recovery();

CREATE OR REPLACE FUNCTION supacloud_commands.execution_status(request jsonb)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $status$
  SELECT jsonb_build_object('kind','execution','commandId',r.dispatch_key,
    'execution',jsonb_build_object('tenantId',r.tenant_id,'actorId',r.actor_id,
      'command',r.command,'operationId',r.operation_key,'dispatchKey',r.dispatch_key,
      'status',r.status,'audit',r.audit_state)
      || CASE WHEN r.status='confirmed' THEN jsonb_build_object('result',r.result) ELSE '{}'::jsonb END,
    'workflow',CASE WHEN w.id IS NULL THEN NULL ELSE jsonb_build_object('runId',w.id,'status',w.status) END)
  FROM supacloud_commands.execution_receipts r
  LEFT JOIN supacloud_workflows.runs w ON w.id=r.dispatch_key
  WHERE CASE WHEN request ? 'commandId' THEN r.dispatch_key::text=request->>'commandId'
    ELSE r.tenant_id=request->>'tenantId' AND r.actor_id=request->>'actorId'
      AND r.command=request->>'command' AND r.operation_key=request->>'operationId' END
$status$;
REVOKE ALL ON FUNCTION supacloud_commands.execution_status(jsonb) FROM PUBLIC;
`;

/** Explicit migration from the unreleased v1 prototype. Never discard operation keys. */
export const COMMAND_PERSISTENCE_UPGRADE_SQL = `
ALTER TABLE supacloud_commands.execution_receipts
  ADD COLUMN IF NOT EXISTS input_fingerprint text,
  ADD COLUMN IF NOT EXISTS input_payload text;
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='supacloud_commands'
    AND table_name='execution_receipts' AND column_name='input_key') THEN
    EXECUTE 'UPDATE supacloud_commands.execution_receipts
      SET input_fingerprint=encode(sha256(convert_to(input_key,''UTF8'')),''hex''),input_payload=input_key
      WHERE input_fingerprint IS NULL';
    ALTER TABLE supacloud_commands.execution_receipts DROP COLUMN input_key;
  END IF;
END
$migration$;
ALTER TABLE supacloud_commands.execution_receipts ALTER COLUMN input_fingerprint SET NOT NULL;
ALTER TABLE supacloud_commands.execution_receipts
  DROP CONSTRAINT IF EXISTS execution_receipts_status_check,
  DROP CONSTRAINT IF EXISTS execution_receipts_check1,
  DROP CONSTRAINT IF EXISTS execution_receipts_transactional_check,
  DROP CONSTRAINT IF EXISTS execution_receipts_audit_terminal_check;
ALTER TABLE supacloud_commands.execution_receipts
  ADD CONSTRAINT execution_receipts_status_check CHECK (status IN ('pending','unknown','confirmed','rejected')),
  ADD CONSTRAINT execution_receipts_transactional_check CHECK (
    kind <> 'transactional' OR (status = 'confirmed' AND audit_state = 'complete')),
  ADD CONSTRAINT execution_receipts_audit_terminal_check CHECK (
    (audit_state <> 'complete' OR status IN ('confirmed','rejected'))
    AND (status <> 'rejected' OR audit_state = 'complete'));
DO $constraint$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='supacloud_commands.execution_receipts'::regclass
      AND conname='execution_receipts_input_fingerprint_check') THEN
    ALTER TABLE supacloud_commands.execution_receipts
      ADD CONSTRAINT execution_receipts_input_fingerprint_check CHECK (input_fingerprint ~ '^[a-f0-9]{64}$');
  END IF;
END
$constraint$;
${COMMAND_PERSISTENCE_SQL}
DO $backfill$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM supacloud_commands.execution_receipts
    WHERE kind='external' AND status<>'rejected' AND (status<>'confirmed' OR audit_state<>'complete')
      AND NOT EXISTS(SELECT FROM supacloud_workflows.runs w WHERE w.id=dispatch_key)
  LOOP
    PERFORM supacloud_workflows.start_run(
      r.dispatch_key,'supacloud.command.reconcile','1','reconcile',
      jsonb_build_object('commandId',r.dispatch_key,'tenantId',r.tenant_id,
        'actorId',r.actor_id,'command',r.command,'operationId',r.operation_key),20
    );
  END LOOP;
END
$backfill$;
DROP INDEX IF EXISTS supacloud_commands.execution_pending_recovery;
ALTER TABLE supacloud_commands.execution_receipts
  DROP COLUMN IF EXISTS lease_id,
  DROP COLUMN IF EXISTS lease_until,
  DROP COLUMN IF EXISTS next_attempt_at,
  DROP COLUMN IF EXISTS recovery_attempts;
`;
