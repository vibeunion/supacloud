CREATE SCHEMA IF NOT EXISTS supacloud_commands;
REVOKE ALL ON SCHEMA supacloud_commands FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA supacloud_commands TO service_role;

CREATE TABLE IF NOT EXISTS supacloud_commands.receipts (
  id uuid PRIMARY KEY,
  command_type text NOT NULL
    CHECK (command_type ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  target_type text NOT NULL
    CHECK (target_type ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  target_id text NOT NULL CHECK (char_length(target_id) BETWEEN 1 AND 500),
  actor_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload) = 'object'),
  payload_fingerprint text NOT NULL CHECK (char_length(payload_fingerprint) = 36),
  workflow_run_id uuid NOT NULL UNIQUE
    REFERENCES supacloud_workflows.runs(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS supacloud_commands_target_idx
  ON supacloud_commands.receipts (target_type, target_id, created_at DESC, id);

ALTER TABLE supacloud_commands.receipts ADD COLUMN IF NOT EXISTS tenant_id text;

CREATE OR REPLACE FUNCTION supacloud_commands.snapshot(
  p_command_id uuid,
  p_idempotent boolean DEFAULT false
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'commandId', receipt.id,
    'commandType', receipt.command_type,
    'targetType', receipt.target_type,
    'targetId', receipt.target_id,
    'actorId', receipt.actor_id,
    'tenantId', receipt.tenant_id,
    'payloadFingerprint', receipt.payload_fingerprint,
    'createdAt', receipt.created_at,
    'idempotent', p_idempotent,
    'workflow', supacloud_workflows.snapshot(receipt.workflow_run_id, false)
  )
  FROM supacloud_commands.receipts receipt
  WHERE receipt.id = p_command_id
$$;

-- Application-owned SECURITY DEFINER RPCs may call this after their domain
-- mutation. PostgreSQL commits the domain write, receipt, and workflow enqueue
-- together, so a lost response can be replayed with the same command ID.
DROP FUNCTION IF EXISTS supacloud_commands.submit(uuid, text, text, text, uuid, jsonb, integer);
CREATE OR REPLACE FUNCTION supacloud_commands.submit(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  command_id_text text;
  command_id uuid;
  actor_id uuid;
  max_attempts integer;
  payload jsonb;
  normalized_command_type text;
  normalized_target_type text;
  normalized_target_id text;
  fingerprint text;
  existing supacloud_commands.receipts%ROWTYPE;
  tenant_id text;
  existing_execution jsonb;
BEGIN
  IF jsonb_typeof(request) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'SUPACLOUD_COMMAND_INVALID' USING ERRCODE = '22023';
  END IF;
  command_id_text := request ->> 'commandId';
  IF command_id_text IS NULL
     OR command_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'SUPACLOUD_COMMAND_INVALID' USING ERRCODE = '22023';
  END IF;
  command_id := command_id_text::uuid;
  tenant_id := request->>'tenantId';
  IF request ? 'tenantId' AND (jsonb_typeof(request->'tenantId') IS DISTINCT FROM 'string'
    OR tenant_id !~ '^[A-Za-z0-9._:@|-]{1,200}$') THEN
    RAISE EXCEPTION 'SUPACLOUD_COMMAND_INVALID' USING ERRCODE = '22023';
  END IF;
  IF request ? 'actorId' AND request ->> 'actorId' IS NOT NULL THEN
    actor_id := (request ->> 'actorId')::uuid;
  END IF;
  max_attempts := coalesce((request ->> 'maxAttempts')::integer, 3);
  payload := coalesce(request -> 'payload', '{}'::jsonb);
  normalized_command_type := nullif(btrim(request ->> 'commandType'), '');
  normalized_target_type := nullif(btrim(request ->> 'targetType'), '');
  normalized_target_id := nullif(btrim(request ->> 'targetId'), '');
  IF normalized_command_type IS NULL
     OR normalized_command_type !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR normalized_target_type IS NULL
     OR normalized_target_type !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR normalized_target_id IS NULL
     OR char_length(normalized_target_id) > 500
     OR jsonb_typeof(payload) IS DISTINCT FROM 'object'
     OR max_attempts NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'SUPACLOUD_COMMAND_INVALID' USING ERRCODE = '22023';
  END IF;

  fingerprint := 'md5:' || md5(payload::text);
  PERFORM pg_advisory_xact_lock(hashtextextended(command_id::text, 0));
  SELECT * INTO existing FROM supacloud_commands.receipts WHERE id = command_id;
  IF FOUND THEN
    IF existing.command_type <> normalized_command_type
       OR existing.target_type <> normalized_target_type
       OR existing.target_id <> normalized_target_id
       OR existing.actor_id IS DISTINCT FROM actor_id
       OR existing.tenant_id IS DISTINCT FROM tenant_id
       OR existing.payload <> payload
       OR existing.payload_fingerprint <> fingerprint THEN
      RAISE EXCEPTION 'SUPACLOUD_COMMAND_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN supacloud_commands.snapshot(command_id, true);
  END IF;
  IF to_regprocedure('supacloud_commands.execution_status(jsonb)') IS NOT NULL THEN
    EXECUTE 'SELECT supacloud_commands.execution_status($1)' INTO existing_execution
      USING jsonb_build_object('commandId',command_id);
    IF existing_execution IS NOT NULL THEN
      RAISE EXCEPTION 'SUPACLOUD_COMMAND_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
  END IF;

  PERFORM supacloud_workflows.start_run(
    command_id,
    'command.' || normalized_command_type,
    '1',
    'execute',
    jsonb_build_object(
      'commandId', command_id,
      'commandType', normalized_command_type,
      'targetType', normalized_target_type,
      'targetId', normalized_target_id,
      'actorId', actor_id,
      'payload', payload,
      'payloadFingerprint', fingerprint
    ),
    max_attempts
  );

  INSERT INTO supacloud_commands.receipts (
    id, command_type, target_type, target_id, actor_id, payload,
    payload_fingerprint, workflow_run_id, tenant_id
  ) VALUES (
    command_id, normalized_command_type, normalized_target_type,
    normalized_target_id, actor_id, payload, fingerprint, command_id, tenant_id
  );
  RETURN supacloud_commands.snapshot(command_id, false);
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'SUPACLOUD_COMMAND_INVALID' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION supacloud_commands.status(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  command_id_text text;
  execution jsonb;
  submission jsonb;
  field text;
BEGIN
  IF jsonb_typeof(request) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'SUPACLOUD_COMMAND_GET_INVALID' USING ERRCODE = '22023';
  END IF;
  IF request ? 'commandId' THEN
    IF jsonb_typeof(request->'commandId') IS DISTINCT FROM 'string'
      OR request->>'commandId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR EXISTS(SELECT FROM jsonb_object_keys(request) AS k WHERE k <> 'commandId') THEN
      RAISE EXCEPTION 'SUPACLOUD_COMMAND_GET_INVALID' USING ERRCODE = '22023';
    END IF;
    request := jsonb_build_object('commandId',(request->>'commandId')::uuid::text);
  ELSE
    IF EXISTS(SELECT FROM jsonb_object_keys(request) AS k WHERE k NOT IN ('tenantId','actorId','command','operationId')) THEN
      RAISE EXCEPTION 'SUPACLOUD_COMMAND_GET_INVALID' USING ERRCODE = '22023';
    END IF;
    FOREACH field IN ARRAY ARRAY['tenantId','actorId','command','operationId'] LOOP
      IF jsonb_typeof(request->field) IS DISTINCT FROM 'string' OR request->>field !~ '^[A-Za-z0-9._:@|-]{1,200}$' THEN
        RAISE EXCEPTION 'SUPACLOUD_COMMAND_GET_INVALID' USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;
  IF to_regprocedure('supacloud_commands.execution_status(jsonb)') IS NOT NULL THEN
    EXECUTE 'SELECT supacloud_commands.execution_status($1)' INTO execution USING request;
    IF execution IS NOT NULL THEN RETURN execution; END IF;
  END IF;
  IF NOT (request ? 'commandId') THEN
    IF jsonb_typeof(request->'tenantId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(request->'actorId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(request->'command') IS DISTINCT FROM 'string'
      OR jsonb_typeof(request->'operationId') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'SUPACLOUD_COMMAND_GET_INVALID' USING ERRCODE = '22023';
    END IF;
    RETURN NULL;
  END IF;
  command_id_text := request ->> 'commandId';
  IF command_id_text IS NULL
     OR command_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'SUPACLOUD_COMMAND_GET_INVALID' USING ERRCODE = '22023';
  END IF;
  submission := supacloud_commands.snapshot(command_id_text::uuid, false);
  IF submission IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('kind','submission','commandId',command_id_text::uuid,
    'execution',NULL,'workflow',jsonb_build_object(
      'runId',submission->'workflow'->'runId','status',submission->'workflow'->'status'));
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation THEN
    RAISE EXCEPTION 'SUPACLOUD_COMMAND_GET_INVALID' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.supacloud_command_submit(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM supacloud_commands.submit(request);
  RETURN supacloud_commands.status(jsonb_build_object('commandId',request->>'commandId'));
END
$$;

CREATE OR REPLACE FUNCTION public.supacloud_command_get(request jsonb)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT supacloud_commands.status(request)
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA supacloud_commands
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA supacloud_commands
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.supacloud_command_submit(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.supacloud_command_get(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.supacloud_command_submit(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.supacloud_command_get(jsonb) TO service_role;
