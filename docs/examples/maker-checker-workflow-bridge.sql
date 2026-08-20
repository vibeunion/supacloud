-- Optional application migration applied after maker-checker-state-machine.sql.
-- It atomically appends workflow intent. A trusted service-role dispatcher
-- starts SupaCloud Durable Workflows after commit with the stored run ID.

CREATE TABLE public.review_document_workflow_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transition_event_id bigint NOT NULL UNIQUE
    REFERENCES public.review_document_transition_events(id) ON DELETE RESTRICT,
  document_id uuid NOT NULL
    REFERENCES public.review_documents(id) ON DELETE RESTRICT,
  workflow_run_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  workflow_name text NOT NULL,
  workflow_version text NOT NULL,
  first_step_key text NOT NULL,
  entity_version bigint NOT NULL CHECK (entity_version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.review_document_workflow_dispatches (
  outbox_id bigint PRIMARY KEY
    REFERENCES public.review_document_workflow_outbox(id) ON DELETE RESTRICT,
  claimed_by text NOT NULL CHECK (char_length(claimed_by) BETWEEN 1 AND 120),
  claim_token uuid NOT NULL,
  claimed_until timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 100),
  dispatched_at timestamptz,
  dead_lettered_at timestamptz,
  last_error text NOT NULL DEFAULT '' CHECK (char_length(last_error) <= 2000),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX review_document_workflow_outbox_document_idx
  ON public.review_document_workflow_outbox (document_id, id);
CREATE INDEX review_document_workflow_dispatch_pending_idx
  ON public.review_document_workflow_dispatches (claimed_until, outbox_id)
  WHERE dispatched_at IS NULL AND dead_lettered_at IS NULL;

ALTER TABLE public.review_document_workflow_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_document_workflow_dispatches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.review_document_workflow_outbox
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.review_document_workflow_dispatches
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_review_document_workflow_outbox_append_only()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'REVIEW_DOCUMENT_WORKFLOW_OUTBOX_APPEND_ONLY' USING ERRCODE = '55000';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_review_document_workflow_outbox_append_only()
  FROM PUBLIC;

CREATE TRIGGER review_document_workflow_outbox_append_only
BEFORE UPDATE OR DELETE ON public.review_document_workflow_outbox
FOR EACH ROW EXECUTE FUNCTION public.guard_review_document_workflow_outbox_append_only();

CREATE TRIGGER review_document_workflow_outbox_no_truncate
BEFORE TRUNCATE ON public.review_document_workflow_outbox
FOR EACH STATEMENT EXECUTE FUNCTION public.guard_review_document_workflow_outbox_append_only();

CREATE OR REPLACE FUNCTION public.enqueue_review_document_workflow_intent()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_workflow_name text;
  v_first_step_key text;
BEGIN
  CASE NEW.event
    WHEN 'approve' THEN
      v_workflow_name := 'review-document.after-approval';
      v_first_step_key := 'render';
    WHEN 'complete' THEN
      v_workflow_name := 'review-document.after-completion';
      v_first_step_key := 'archive';
    ELSE
      RETURN NEW;
  END CASE;

  INSERT INTO public.review_document_workflow_outbox (
    transition_event_id, document_id, workflow_name,
    workflow_version, first_step_key, entity_version
  ) VALUES (
    NEW.id, NEW.document_id, v_workflow_name,
    '1', v_first_step_key, NEW.entity_version
  );

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_review_document_workflow_intent()
  FROM PUBLIC;

CREATE TRIGGER review_document_workflow_handoff
AFTER INSERT ON public.review_document_transition_events
FOR EACH ROW EXECUTE FUNCTION public.enqueue_review_document_workflow_intent();

CREATE OR REPLACE FUNCTION public.claim_review_document_workflow(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_worker_id text;
  v_lease_seconds integer;
  v_claim_token uuid := gen_random_uuid();
  v_candidate public.review_document_workflow_outbox%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role'
     OR jsonb_typeof(request) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'REVIEW_DOCUMENT_WORKFLOW_CLAIM_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  v_worker_id := nullif(btrim(request ->> 'workerId'), '');
  v_lease_seconds := coalesce((request ->> 'leaseSeconds')::integer, 300);
  IF v_worker_id IS NULL
     OR char_length(v_worker_id) > 120
     OR v_lease_seconds NOT BETWEEN 30 AND 900 THEN
    RAISE EXCEPTION 'REVIEW_DOCUMENT_WORKFLOW_CLAIM_INVALID' USING ERRCODE = '22023';
  END IF;

  UPDATE public.review_document_workflow_dispatches dispatch
  SET dead_lettered_at = now(),
      last_error = CASE
        WHEN dispatch.last_error = '' THEN 'maximum dispatch attempts reached'
        ELSE dispatch.last_error
      END,
      updated_at = now()
  WHERE dispatch.dispatched_at IS NULL
    AND dispatch.dead_lettered_at IS NULL
    AND dispatch.attempts >= 100
    AND dispatch.claimed_until <= now();

  SELECT outbox.* INTO v_candidate
  FROM public.review_document_workflow_outbox outbox
  LEFT JOIN public.review_document_workflow_dispatches dispatch
    ON dispatch.outbox_id = outbox.id
  WHERE dispatch.dispatched_at IS NULL
    AND dispatch.dead_lettered_at IS NULL
    AND (dispatch.outbox_id IS NULL OR dispatch.claimed_until <= now())
  ORDER BY outbox.id
  FOR UPDATE OF outbox SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.review_document_workflow_dispatches (
    outbox_id, claimed_by, claim_token, claimed_until
  ) VALUES (
    v_candidate.id, v_worker_id, v_claim_token,
    now() + make_interval(secs => v_lease_seconds)
  )
  ON CONFLICT (outbox_id) DO UPDATE
  SET claimed_by = EXCLUDED.claimed_by,
      claim_token = EXCLUDED.claim_token,
      claimed_until = EXCLUDED.claimed_until,
      attempts = public.review_document_workflow_dispatches.attempts + 1,
      last_error = '',
      updated_at = now()
  WHERE public.review_document_workflow_dispatches.dispatched_at IS NULL
    AND public.review_document_workflow_dispatches.dead_lettered_at IS NULL
    AND public.review_document_workflow_dispatches.claimed_until <= now();

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'outboxId', v_candidate.id::text,
    'claimToken', v_claim_token,
    'runId', v_candidate.workflow_run_id,
    'workflowName', v_candidate.workflow_name,
    'workflowVersion', v_candidate.workflow_version,
    'firstStepKey', v_candidate.first_step_key,
    'input', jsonb_build_object(
      'documentId', v_candidate.document_id,
      'transitionEventId', v_candidate.transition_event_id::text,
      'entityVersion', v_candidate.entity_version::text
    )
  );
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'REVIEW_DOCUMENT_WORKFLOW_CLAIM_INVALID' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_review_document_workflow_dispatch(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_outbox_id bigint;
  v_claim_token uuid;
  v_worker_id text;
BEGIN
  IF auth.role() <> 'service_role'
     OR jsonb_typeof(request) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'REVIEW_DOCUMENT_WORKFLOW_COMPLETE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  v_outbox_id := (request ->> 'outboxId')::bigint;
  v_claim_token := (request ->> 'claimToken')::uuid;
  v_worker_id := nullif(btrim(request ->> 'workerId'), '');
  IF v_outbox_id < 1 OR v_claim_token IS NULL OR v_worker_id IS NULL THEN
    RAISE EXCEPTION 'REVIEW_DOCUMENT_WORKFLOW_COMPLETE_INVALID' USING ERRCODE = '22023';
  END IF;

  UPDATE public.review_document_workflow_dispatches dispatch
  SET dispatched_at = now(),
      claimed_until = now(),
      updated_at = now()
  WHERE dispatch.outbox_id = v_outbox_id
    AND dispatch.claim_token = v_claim_token
    AND dispatch.claimed_by = v_worker_id
    AND dispatch.dispatched_at IS NULL
    AND dispatch.dead_lettered_at IS NULL
    AND dispatch.claimed_until > now();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'REVIEW_DOCUMENT_WORKFLOW_CLAIM_STALE' USING ERRCODE = '40001';
  END IF;

  RETURN jsonb_build_object('outboxId', v_outbox_id::text, 'dispatched', true);
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'REVIEW_DOCUMENT_WORKFLOW_COMPLETE_INVALID' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.release_review_document_workflow_dispatch(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_outbox_id bigint;
  v_claim_token uuid;
  v_worker_id text;
  v_error_message text;
  v_terminal boolean;
  v_dead_lettered boolean;
BEGIN
  IF auth.role() <> 'service_role'
     OR jsonb_typeof(request) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'REVIEW_DOCUMENT_WORKFLOW_RELEASE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  v_outbox_id := (request ->> 'outboxId')::bigint;
  v_claim_token := (request ->> 'claimToken')::uuid;
  v_worker_id := nullif(btrim(request ->> 'workerId'), '');
  v_error_message := coalesce(request ->> 'errorMessage', '');
  v_terminal := coalesce((request ->> 'terminal')::boolean, false);
  IF v_outbox_id < 1
     OR v_claim_token IS NULL
     OR v_worker_id IS NULL
     OR char_length(v_error_message) > 2000 THEN
    RAISE EXCEPTION 'REVIEW_DOCUMENT_WORKFLOW_RELEASE_INVALID' USING ERRCODE = '22023';
  END IF;

  UPDATE public.review_document_workflow_dispatches dispatch
  SET claimed_until = now(),
      last_error = v_error_message,
      dead_lettered_at = CASE
        WHEN v_terminal OR dispatch.attempts >= 100 THEN now()
        ELSE NULL
      END,
      updated_at = now()
  WHERE dispatch.outbox_id = v_outbox_id
    AND dispatch.claim_token = v_claim_token
    AND dispatch.claimed_by = v_worker_id
    AND dispatch.dispatched_at IS NULL
    AND dispatch.dead_lettered_at IS NULL
  RETURNING dispatch.dead_lettered_at IS NOT NULL INTO v_dead_lettered;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'REVIEW_DOCUMENT_WORKFLOW_CLAIM_STALE' USING ERRCODE = '40001';
  END IF;

  RETURN jsonb_build_object(
    'outboxId', v_outbox_id::text,
    'released', true,
    'deadLettered', v_dead_lettered
  );
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'REVIEW_DOCUMENT_WORKFLOW_RELEASE_INVALID' USING ERRCODE = '22023';
END;
$$;

REVOKE ALL ON FUNCTION public.claim_review_document_workflow(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_review_document_workflow_dispatch(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_review_document_workflow_dispatch(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_review_document_workflow(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_review_document_workflow_dispatch(jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.release_review_document_workflow_dispatch(jsonb)
  TO service_role;

-- Dispatcher sequence:
-- 1. claim_review_document_workflow()
-- 2. supacloud_workflow_start() with the returned fixed runId and input
-- 3. complete_review_document_workflow_dispatch()
-- A crash after step 2 retries the same runId, so workflow start is idempotent.
