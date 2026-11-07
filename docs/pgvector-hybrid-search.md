# pgvector 混合检索 Starter

SupaCloud 的 PostgreSQL 镜像已经提供 `vector` 和 `pg_trgm`。下面的模板把向量召回、
PostgreSQL 全文检索和 RRF 合并放在同一个项目数据库中，适合先作为项目迁移的起点。

它不替代业务授权：应用必须把 `owner_id`、组织或租户字段换成自己的权限模型，并在真实项目
中补齐 RLS 验收。

## 表和索引

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.search_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  source_id text NOT NULL,
  content text NOT NULL,
  content_hash text GENERATED ALWAYS AS (
    encode(digest(convert_to(content, 'utf8'), 'sha256'), 'hex')
  ) STORED,
  embedding vector(1536),
  embedding_model text,
  embedded_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  search_text tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(content, ''))
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, source_id)
);

CREATE INDEX IF NOT EXISTS search_documents_embedding_hnsw_idx
  ON public.search_documents
  USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

CREATE INDEX IF NOT EXISTS search_documents_search_text_gin_idx
  ON public.search_documents USING gin (search_text);

CREATE INDEX IF NOT EXISTS search_documents_content_trgm_idx
  ON public.search_documents USING gin (content gin_trgm_ops);

ALTER TABLE public.search_documents ENABLE ROW LEVEL SECURITY;
```

The `owner_id` policy below assumes Supabase-compatible `auth.uid()`. Replace it when an application
uses a different verified JWT claim or organization membership function.

```sql
CREATE POLICY search_documents_select_own
  ON public.search_documents FOR SELECT
  USING (owner_id = auth.uid());

CREATE POLICY search_documents_write_own
  ON public.search_documents FOR ALL
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());
```

## RRF 查询函数

The function keeps authorization in the table's RLS policy. It deliberately does not accept a caller
supplied owner filter as a substitute for RLS.

```sql
CREATE OR REPLACE FUNCTION public.hybrid_search_documents(
  query_embedding vector(1536),
  query_text text,
  match_count integer DEFAULT 20,
  rrf_k integer DEFAULT 60
)
RETURNS TABLE (
  id uuid,
  source_id text,
  content text,
  metadata jsonb,
  score double precision
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF match_count < 1 OR match_count > 100 THEN
    RAISE EXCEPTION 'match_count must be between 1 and 100' USING ERRCODE = '22023';
  END IF;
  IF rrf_k < 1 OR rrf_k > 1000 THEN
    RAISE EXCEPTION 'rrf_k must be between 1 and 1000' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH vector_hits AS (
    SELECT d.id, row_number() OVER (
      ORDER BY d.embedding <=> query_embedding
    )::double precision AS rank
    FROM public.search_documents AS d
    WHERE query_embedding IS NOT NULL
      AND d.embedding IS NOT NULL
    ORDER BY d.embedding <=> query_embedding
    LIMIT greatest(match_count, 1) * 4
  ),
  text_hits AS (
    SELECT d.id, row_number() OVER (
      ORDER BY ts_rank_cd(
        d.search_text,
        websearch_to_tsquery('simple', nullif(query_text, ''))
      ) DESC,
      d.id
    )::double precision AS rank
    FROM public.search_documents AS d
    WHERE nullif(btrim(query_text), '') IS NOT NULL
      AND d.search_text @@ websearch_to_tsquery('simple', query_text)
    ORDER BY ts_rank_cd(
      d.search_text,
      websearch_to_tsquery('simple', query_text)
    ) DESC,
    d.id
    LIMIT greatest(match_count, 1) * 4
  ),
  trigram_hits AS (
    SELECT d.id, row_number() OVER (
      ORDER BY similarity(d.content, query_text) DESC, d.id
    )::double precision AS rank
    FROM public.search_documents AS d
    WHERE nullif(btrim(query_text), '') IS NOT NULL
      AND d.content % query_text
    ORDER BY similarity(d.content, query_text) DESC, d.id
    LIMIT greatest(match_count, 1) * 4
  ),
  fused AS (
    SELECT id, sum(1.0 / (rrf_k + rank)) AS score
    FROM (
      SELECT id, rank FROM vector_hits
      UNION ALL
      SELECT id, rank FROM text_hits
      UNION ALL
      SELECT id, rank FROM trigram_hits
    ) AS candidates
    GROUP BY id
  )
  SELECT d.id, d.source_id, d.content, d.metadata, fused.score
  FROM fused
  JOIN public.search_documents AS d ON d.id = fused.id
  ORDER BY fused.score DESC, d.id
  LIMIT greatest(match_count, 1);
END;
$$;

REVOKE ALL ON FUNCTION public.hybrid_search_documents(vector, text, integer, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hybrid_search_documents(vector, text, integer, integer)
  TO authenticated, service_role;
```

For a project that does not use `auth.uid()`, expose this function only through a trusted RPC or add
an application-owned membership predicate to the function and its policies. Do not grant `service_role`
to browser code.

## Embedding job boundary

1. The application writes or updates a document and stores an idempotency key such as
   `embedding:<document-id>:<content-hash>`.
2. It sends that key to the project's existing PGMQ queue using `pgmq_public.send_idempotent`.
3. A trusted Worker or Edge Function reads the message, calls the selected embedding provider, and
   updates `embedding`, `embedding_model`, and `embedded_at` only when the stored `content_hash`
   still matches the hash in the message.
4. The worker acknowledges the message after the database update. Provider failures release the message
   with a bounded visibility delay; permanent failures go to an application-owned failure table.

This keeps model credentials and provider calls outside PostgreSQL while reusing SupaCloud's existing
PGMQ, Worker, retry and observability boundaries.

## Acceptance checklist

- `vector` and `pg_trgm` are available in the target project database.
- The migration is transactional and records the embedding dimension and model revision.
- Two authenticated subjects cannot read each other's rows through either table access or the RPC.
- Empty text, missing embeddings, duplicate source IDs, invalid `match_count`, and invalid `rrf_k` are handled explicitly.
- A stale embedding job cannot overwrite a newer content hash.
- Queue retry, provider timeout and database conflict each have bounded, observable outcomes.
- HNSW/GIN performance is measured on the target PostgreSQL version before increasing recall limits.
