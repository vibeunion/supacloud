/** Install through the application's normal migration flow, never during a request. */
export const COMMAND_PERSISTENCE_SQL = `
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
  status text NOT NULL CHECK (status IN ('pending', 'unknown', 'confirmed')),
  audit_state text NOT NULL CHECK (audit_state IN ('pending', 'complete')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  recovery_attempts integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, actor_id, command, operation_key),
  CHECK ((status = 'confirmed') = (result IS NOT NULL)),
  CHECK (audit_state <> 'complete' OR status = 'confirmed'),
  CHECK (kind <> 'transactional' OR (status = 'confirmed' AND audit_state = 'complete'))
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
CREATE INDEX IF NOT EXISTS execution_pending_recovery
  ON supacloud_commands.execution_receipts (tenant_id,command,next_attempt_at,created_at)
  WHERE status<>'confirmed' OR audit_state<>'complete';
`;

/** Explicit migration from the unreleased v1 prototype. Never discard operation keys. */
export const COMMAND_PERSISTENCE_UPGRADE_SQL = `
ALTER TABLE supacloud_commands.execution_receipts
  ADD COLUMN IF NOT EXISTS input_fingerprint text,
  ADD COLUMN IF NOT EXISTS input_payload text,
  ADD COLUMN IF NOT EXISTS lease_id uuid,
  ADD COLUMN IF NOT EXISTS lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS recovery_attempts integer NOT NULL DEFAULT 0;
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
CREATE INDEX IF NOT EXISTS execution_pending_recovery
  ON supacloud_commands.execution_receipts (tenant_id,command,next_attempt_at,created_at)
  WHERE status<>'confirmed' OR audit_state<>'complete';
`;
