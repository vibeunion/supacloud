CREATE SCHEMA IF NOT EXISTS supacloud_artifacts;
REVOKE ALL ON SCHEMA supacloud_artifacts FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA supacloud_artifacts TO service_role;

CREATE TABLE IF NOT EXISTS supacloud_artifacts.artifacts (
  id uuid PRIMARY KEY,
  storage_object_id uuid NOT NULL UNIQUE REFERENCES storage.objects(id) ON DELETE RESTRICT,
  bucket_id text NOT NULL,
  object_path text NOT NULL,
  object_version text NOT NULL,
  artifact_type text NOT NULL
    CHECK (artifact_type ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  mime_type text NOT NULL CHECK (char_length(mime_type) BETWEEN 1 AND 255),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  retention_until timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (retention_until IS NULL OR retention_until >= created_at),
  UNIQUE (bucket_id, object_path, object_version)
);

CREATE INDEX IF NOT EXISTS supacloud_artifacts_lookup_idx
  ON supacloud_artifacts.artifacts (artifact_type, created_at DESC, id);

CREATE TABLE IF NOT EXISTS supacloud_artifacts.lineage (
  parent_artifact_id uuid NOT NULL REFERENCES supacloud_artifacts.artifacts(id) ON DELETE RESTRICT,
  child_artifact_id uuid NOT NULL REFERENCES supacloud_artifacts.artifacts(id) ON DELETE RESTRICT,
  relation_type text NOT NULL
    CHECK (relation_type ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (parent_artifact_id, child_artifact_id, relation_type),
  CHECK (parent_artifact_id <> child_artifact_id)
);

CREATE INDEX IF NOT EXISTS supacloud_artifacts_lineage_child_idx
  ON supacloud_artifacts.lineage (child_artifact_id, created_at, parent_artifact_id);

CREATE OR REPLACE FUNCTION supacloud_artifacts.guard_storage_object()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM supacloud_artifacts.artifacts artifact
    WHERE artifact.storage_object_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'SUPACLOUD_ARTIFACT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS supacloud_artifact_storage_fence ON storage.objects;
CREATE TRIGGER supacloud_artifact_storage_fence
BEFORE UPDATE OR DELETE ON storage.objects
FOR EACH ROW EXECUTE FUNCTION supacloud_artifacts.guard_storage_object();

CREATE OR REPLACE FUNCTION supacloud_artifacts.snapshot(
  p_artifact_id uuid,
  p_idempotent boolean DEFAULT false
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'artifactId', artifact.id,
    'bucketId', artifact.bucket_id,
    'objectPath', artifact.object_path,
    'objectVersion', artifact.object_version,
    'artifactType', artifact.artifact_type,
    'sha256', artifact.sha256,
    'sizeBytes', artifact.size_bytes::text,
    'mimeType', artifact.mime_type,
    'metadata', artifact.metadata,
    'retentionUntil', artifact.retention_until,
    'createdBy', artifact.created_by,
    'createdAt', artifact.created_at,
    'idempotent', p_idempotent,
    'parents', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'artifactId', edge.parent_artifact_id,
        'relationType', edge.relation_type,
        'metadata', edge.metadata,
        'createdAt', edge.created_at
      ) ORDER BY edge.created_at, edge.parent_artifact_id)
      FROM supacloud_artifacts.lineage edge
      WHERE edge.child_artifact_id = artifact.id
    ), '[]'::jsonb)
  )
  FROM supacloud_artifacts.artifacts artifact
  WHERE artifact.id = p_artifact_id
$$;

DROP FUNCTION IF EXISTS supacloud_artifacts.register(uuid, text, text, text, text, bigint, text, jsonb, timestamptz, uuid);
CREATE OR REPLACE FUNCTION supacloud_artifacts.register(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  artifact_id uuid;
  size_bytes bigint;
  metadata jsonb;
  retention_until timestamptz;
  created_by uuid;
  normalized_bucket text;
  normalized_path text;
  normalized_type text;
  normalized_sha256 text;
  normalized_mime text;
  object_row storage.objects%ROWTYPE;
  existing supacloud_artifacts.artifacts%ROWTYPE;
BEGIN
  IF jsonb_typeof(request) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'SUPACLOUD_ARTIFACT_INVALID' USING ERRCODE = '22023';
  END IF;
  artifact_id := (request ->> 'artifactId')::uuid;
  size_bytes := (request ->> 'sizeBytes')::bigint;
  metadata := coalesce(request -> 'metadata', '{}'::jsonb);
  retention_until := (request ->> 'retentionUntil')::timestamptz;
  created_by := (request ->> 'createdBy')::uuid;
  normalized_bucket := nullif(btrim(request ->> 'bucketId'), '');
  normalized_path := nullif(btrim(request ->> 'objectPath'), '');
  normalized_type := nullif(btrim(request ->> 'artifactType'), '');
  normalized_sha256 := lower(nullif(btrim(request ->> 'sha256'), ''));
  normalized_mime := lower(nullif(btrim(request ->> 'mimeType'), ''));
  IF artifact_id IS NULL OR normalized_bucket IS NULL OR normalized_path IS NULL
     OR normalized_path LIKE '/%' OR normalized_path LIKE '%\\%'
     OR normalized_path ~ '(^|/)(\.|\.\.)(/|$)'
     OR normalized_type IS NULL
     OR normalized_type !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR normalized_sha256 IS NULL OR normalized_sha256 !~ '^[0-9a-f]{64}$'
     OR size_bytes IS NULL OR size_bytes < 0
     OR normalized_mime IS NULL OR char_length(normalized_mime) > 255
     OR jsonb_typeof(metadata) IS DISTINCT FROM 'object'
     OR (retention_until IS NOT NULL AND retention_until < now()) THEN
    RAISE EXCEPTION 'SUPACLOUD_ARTIFACT_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO object_row FROM storage.objects
  WHERE bucket_id = normalized_bucket AND name = normalized_path;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUPACLOUD_ARTIFACT_OBJECT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(artifact_id::text, 0));
  SELECT * INTO existing FROM supacloud_artifacts.artifacts WHERE id = artifact_id;
  IF FOUND THEN
    IF existing.storage_object_id <> object_row.id
       OR existing.artifact_type <> normalized_type
       OR existing.sha256 <> normalized_sha256
       OR existing.size_bytes <> size_bytes
       OR existing.mime_type <> normalized_mime
       OR existing.metadata <> metadata
       OR existing.retention_until IS DISTINCT FROM retention_until
       OR existing.created_by IS DISTINCT FROM created_by THEN
      RAISE EXCEPTION 'SUPACLOUD_ARTIFACT_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN supacloud_artifacts.snapshot(artifact_id, true);
  END IF;

  INSERT INTO supacloud_artifacts.artifacts (
    id, storage_object_id, bucket_id, object_path, object_version,
    artifact_type, sha256, size_bytes, mime_type, metadata,
    retention_until, created_by
  ) VALUES (
    artifact_id, object_row.id, normalized_bucket, normalized_path,
    object_row.version::text, normalized_type, normalized_sha256,
    size_bytes, normalized_mime, metadata, retention_until, created_by
  );
  RETURN supacloud_artifacts.snapshot(artifact_id, false);
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'SUPACLOUD_ARTIFACT_INVALID' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION supacloud_artifacts.link(
  p_parent_artifact_id uuid,
  p_child_artifact_id uuid,
  p_relation_type text,
  p_metadata jsonb
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  normalized_relation text := nullif(btrim(p_relation_type), '');
  inserted_count integer;
BEGIN
  IF p_parent_artifact_id IS NULL OR p_child_artifact_id IS NULL
     OR p_parent_artifact_id = p_child_artifact_id
     OR normalized_relation IS NULL
     OR normalized_relation !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR jsonb_typeof(p_metadata) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'SUPACLOUD_ARTIFACT_LINEAGE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    WITH RECURSIVE descendants(artifact_id) AS (
      SELECT edge.child_artifact_id
      FROM supacloud_artifacts.lineage edge
      WHERE edge.parent_artifact_id = p_child_artifact_id
      UNION
      SELECT edge.child_artifact_id
      FROM supacloud_artifacts.lineage edge
      JOIN descendants current ON edge.parent_artifact_id = current.artifact_id
    )
    SELECT 1 FROM descendants WHERE artifact_id = p_parent_artifact_id
  ) THEN
    RAISE EXCEPTION 'SUPACLOUD_ARTIFACT_LINEAGE_CYCLE' USING ERRCODE = '23514';
  END IF;
  INSERT INTO supacloud_artifacts.lineage (
    parent_artifact_id, child_artifact_id, relation_type, metadata
  ) VALUES (
    p_parent_artifact_id, p_child_artifact_id, normalized_relation, p_metadata
  ) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count = 0 AND NOT EXISTS (
    SELECT 1 FROM supacloud_artifacts.lineage
    WHERE parent_artifact_id = p_parent_artifact_id
      AND child_artifact_id = p_child_artifact_id
      AND relation_type = normalized_relation
      AND metadata = p_metadata
  ) THEN
    RAISE EXCEPTION 'SUPACLOUD_ARTIFACT_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
  END IF;
  RETURN supacloud_artifacts.snapshot(p_child_artifact_id, inserted_count = 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.supacloud_artifact_register(request jsonb)
RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  SELECT supacloud_artifacts.register(request)
$$;

CREATE OR REPLACE FUNCTION public.supacloud_artifact_get(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN supacloud_artifacts.snapshot((request ->> 'artifactId')::uuid, false);
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation THEN
    RAISE EXCEPTION 'SUPACLOUD_ARTIFACT_GET_INVALID' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.supacloud_artifact_link(request jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN supacloud_artifacts.link(
    (request ->> 'parentArtifactId')::uuid,
    (request ->> 'childArtifactId')::uuid,
    request ->> 'relationType',
    coalesce(request -> 'metadata', '{}'::jsonb)
  );
EXCEPTION
  WHEN invalid_parameter_value OR invalid_text_representation THEN
    RAISE EXCEPTION 'SUPACLOUD_ARTIFACT_LINEAGE_INVALID' USING ERRCODE = '22023';
END;
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA supacloud_artifacts
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA supacloud_artifacts
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.supacloud_artifact_register(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.supacloud_artifact_get(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.supacloud_artifact_link(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.supacloud_artifact_register(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.supacloud_artifact_get(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.supacloud_artifact_link(jsonb) TO service_role;
