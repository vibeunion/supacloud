-- Application migration reference: adapt table and permission names to the domain.
-- The database RPC is authoritative. XState or other clients only project allowed actions.

CREATE TABLE public.review_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'returned', 'approved', 'completed')),
  maker_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  checker_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  submitted_payload jsonb CHECK (
    submitted_payload IS NULL OR jsonb_typeof(submitted_payload) = 'object'
  ),
  submitted_payload_checksum text CHECK (
    submitted_payload_checksum IS NULL
    OR char_length(submitted_payload_checksum) = 32
  ),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (checker_id IS NULL OR checker_id <> maker_id),
  CHECK (
    (
      status IN ('draft', 'returned')
      AND submitted_payload IS NULL
      AND submitted_payload_checksum IS NULL
    )
    OR (
      status IN ('submitted', 'approved', 'completed')
      AND submitted_payload IS NOT NULL
      AND submitted_payload_checksum IS NOT NULL
    )
  )
);

CREATE TABLE public.review_document_members (
  document_id uuid NOT NULL REFERENCES public.review_documents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('maker', 'checker')),
  PRIMARY KEY (document_id, user_id, role)
);

CREATE TABLE public.review_document_transition_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES public.review_documents(id) ON DELETE RESTRICT,
  from_state text NOT NULL,
  to_state text NOT NULL,
  event text NOT NULL CHECK (event IN ('submit', 'return', 'approve', 'complete')),
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  actor_role text NOT NULL CHECK (actor_role IN ('maker', 'checker')),
  reason text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 2000),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  expected_version bigint NOT NULL CHECK (expected_version > 0),
  entity_version bigint NOT NULL CHECK (entity_version > 0),
  payload_checksum text NOT NULL CHECK (char_length(payload_checksum) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, idempotency_key)
);

CREATE INDEX review_document_transition_events_document_idx
  ON public.review_document_transition_events (document_id, id);

ALTER TABLE public.review_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_document_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_document_transition_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY review_documents_member_read
  ON public.review_documents FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.review_document_members member
    WHERE member.document_id = review_documents.id
      AND member.user_id = (SELECT auth.uid())
  ));

CREATE POLICY review_document_members_self_read
  ON public.review_document_members FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY review_document_events_member_read
  ON public.review_document_transition_events FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.review_document_members member
    WHERE member.document_id = review_document_transition_events.document_id
      AND member.user_id = (SELECT auth.uid())
  ));

REVOKE ALL ON public.review_documents FROM anon, authenticated;
REVOKE ALL ON public.review_document_members FROM anon, authenticated;
REVOKE ALL ON public.review_document_transition_events FROM anon, authenticated;
GRANT SELECT ON public.review_documents TO authenticated;
GRANT SELECT ON public.review_document_members TO authenticated;
GRANT SELECT ON public.review_document_transition_events TO authenticated;

CREATE OR REPLACE FUNCTION public.review_document_snapshot(
  p_document_id uuid,
  p_idempotent boolean DEFAULT false
) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'documentId', document.id,
    'status', document.status,
    'makerId', document.maker_id,
    'checkerId', document.checker_id,
    'rowVersion', document.row_version::text,
    'submittedPayloadChecksum', document.submitted_payload_checksum,
    'updatedAt', document.updated_at,
    'idempotent', p_idempotent
  )
  FROM public.review_documents document
  WHERE document.id = p_document_id
$$;

CREATE OR REPLACE FUNCTION public.guard_review_document_transition()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF OLD.payload IS DISTINCT FROM NEW.payload
     AND OLD.status NOT IN ('draft', 'returned') THEN
    RAISE EXCEPTION 'REVIEW_DOCUMENT_PAYLOAD_FROZEN' USING ERRCODE = '55000';
  END IF;

  IF (
       OLD.status IS DISTINCT FROM NEW.status
       OR OLD.checker_id IS DISTINCT FROM NEW.checker_id
       OR OLD.submitted_payload IS DISTINCT FROM NEW.submitted_payload
       OR OLD.submitted_payload_checksum IS DISTINCT FROM NEW.submitted_payload_checksum
       OR OLD.row_version IS DISTINCT FROM NEW.row_version
     )
     AND current_setting('app.review_transition_document_id', true)
       IS DISTINCT FROM OLD.id::text THEN
    RAISE EXCEPTION 'REVIEW_DOCUMENT_DIRECT_TRANSITION_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_review_document_transition() FROM PUBLIC;

CREATE TRIGGER review_document_transition_fence
BEFORE UPDATE ON public.review_documents
FOR EACH ROW EXECUTE FUNCTION public.guard_review_document_transition();

CREATE OR REPLACE FUNCTION public.guard_review_document_event_append_only()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'REVIEW_DOCUMENT_EVENT_APPEND_ONLY' USING ERRCODE = '55000';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_review_document_event_append_only() FROM PUBLIC;

CREATE TRIGGER review_document_event_append_only
BEFORE UPDATE OR DELETE ON public.review_document_transition_events
FOR EACH ROW EXECUTE FUNCTION public.guard_review_document_event_append_only();

CREATE TRIGGER review_document_event_no_truncate
BEFORE TRUNCATE ON public.review_document_transition_events
FOR EACH STATEMENT EXECUTE FUNCTION public.guard_review_document_event_append_only();

CREATE OR REPLACE FUNCTION public.transition_review_document(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_document_id uuid;
  v_actor_id uuid := auth.uid();
  v_transition_event text := nullif(btrim(request ->> 'event'), '');
  v_idempotency_key text := nullif(btrim(request ->> 'idempotencyKey'), '');
  v_reason text := coalesce(btrim(request ->> 'reason'), '');
  v_expected_version bigint;
  v_actor_role text;
  v_target_state text;
  v_payload_checksum text;
  document public.review_documents%ROWTYPE;
  existing_event public.review_document_transition_events%ROWTYPE;
BEGIN
  IF v_actor_id IS NULL OR jsonb_typeof(request) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'REVIEW_DOCUMENT_UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  v_document_id := (request ->> 'documentId')::uuid;
  v_expected_version := (request ->> 'expectedVersion')::bigint;
  IF v_document_id IS NULL
     OR v_expected_version IS NULL
     OR v_transition_event IS NULL
     OR v_idempotency_key IS NULL
     OR char_length(v_idempotency_key) NOT BETWEEN 8 AND 200
     OR char_length(v_reason) > 2000
     OR v_expected_version < 1 THEN
    RAISE EXCEPTION 'REVIEW_DOCUMENT_TRANSITION_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO document
  FROM public.review_documents candidate
  WHERE candidate.id = v_document_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REVIEW_DOCUMENT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO existing_event
  FROM public.review_document_transition_events event_record
  WHERE event_record.document_id = v_document_id
    AND event_record.idempotency_key = v_idempotency_key;
  IF FOUND THEN
    IF existing_event.event <> v_transition_event
       OR existing_event.actor_id <> v_actor_id
       OR existing_event.reason <> v_reason
       OR existing_event.expected_version <> v_expected_version THEN
      RAISE EXCEPTION 'REVIEW_DOCUMENT_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN public.review_document_snapshot(v_document_id, true);
  END IF;

  IF document.row_version <> v_expected_version THEN
    RAISE EXCEPTION 'REVIEW_DOCUMENT_STALE_VERSION' USING ERRCODE = '40001';
  END IF;

  SELECT member.role INTO v_actor_role
  FROM public.review_document_members member
  WHERE member.document_id = v_document_id
    AND member.user_id = v_actor_id
    AND member.role = CASE WHEN v_transition_event = 'submit' THEN 'maker' ELSE 'checker' END;
  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'REVIEW_DOCUMENT_ROLE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  v_payload_checksum := md5(document.payload::text);
  CASE
    WHEN v_transition_event = 'submit'
      AND document.status IN ('draft', 'returned')
      AND v_actor_role = 'maker'
      AND document.maker_id = v_actor_id THEN
        v_target_state := 'submitted';
    WHEN v_transition_event = 'return'
      AND document.status = 'submitted'
      AND v_actor_role = 'checker'
      AND document.maker_id <> v_actor_id
      AND v_reason <> '' THEN
        v_target_state := 'returned';
    WHEN v_transition_event = 'approve'
      AND document.status = 'submitted'
      AND v_actor_role = 'checker'
      AND document.maker_id <> v_actor_id
      AND document.submitted_payload = document.payload
      AND document.submitted_payload_checksum = v_payload_checksum THEN
        v_target_state := 'approved';
    WHEN v_transition_event = 'complete'
      AND document.status = 'approved'
      AND v_actor_role = 'checker'
      AND document.maker_id <> v_actor_id THEN
        v_target_state := 'completed';
    ELSE
      RAISE EXCEPTION 'REVIEW_DOCUMENT_TRANSITION_FORBIDDEN' USING ERRCODE = '55000';
  END CASE;

  PERFORM set_config('app.review_transition_document_id', document.id::text, true);
  UPDATE public.review_documents
  SET status = v_target_state,
      checker_id = CASE
        WHEN v_transition_event IN ('return', 'approve', 'complete') THEN v_actor_id
        ELSE NULL
      END,
      submitted_payload = CASE
        WHEN v_transition_event = 'submit' THEN payload
        WHEN v_transition_event = 'return' THEN NULL
        ELSE submitted_payload
      END,
      submitted_payload_checksum = CASE
        WHEN v_transition_event = 'submit' THEN v_payload_checksum
        WHEN v_transition_event = 'return' THEN NULL
        ELSE submitted_payload_checksum
      END,
      row_version = row_version + 1,
      updated_at = now()
  WHERE id = document.id;

  INSERT INTO public.review_document_transition_events (
    document_id, from_state, to_state, event, actor_id, actor_role,
    reason, idempotency_key, expected_version, entity_version, payload_checksum
  ) VALUES (
    document.id, document.status, v_target_state, v_transition_event, v_actor_id, v_actor_role,
    v_reason, v_idempotency_key, v_expected_version,
    v_expected_version + 1, v_payload_checksum
  );

  RETURN public.review_document_snapshot(document.id, false);
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'REVIEW_DOCUMENT_TRANSITION_INVALID' USING ERRCODE = '22023';
END;
$$;

REVOKE ALL ON FUNCTION public.review_document_snapshot(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transition_review_document(jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transition_review_document(jsonb) TO authenticated;

-- Application intake code owns document/member creation. Do not grant authenticated
-- users direct INSERT/UPDATE/DELETE rights merely to make this reference executable.
