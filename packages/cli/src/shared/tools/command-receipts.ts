// Generated from packages/db/src/command-schema.ts so starter generation has no runtime database dependency.
// app-model-command-starter.test.ts enforces byte-for-byte parity with the database package.
// These are application execution_receipts / execution_audit, not Management API supacloud_commands.receipts.
export const COMMAND_RECEIPT_SQL = `CREATE SCHEMA IF NOT EXISTS supacloud_commands;
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
FOR EACH ROW WHEN (NEW.status = 'rejected')
EXECUTE FUNCTION supacloud_commands.require_rejection_audit();
`;
