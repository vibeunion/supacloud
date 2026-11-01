# Vector ANN

Storage Vector Buckets on a project database query with pgvector. `QueryVectors` is an approximate nearest-neighbor statement (`ORDER BY` the distance operator plus `LIMIT`). It does not load `storage.vectors` into the API process and score every row.

ANN recall, latency, and index usage were **not measured** in this change. The statements are covered by a SQL harness. Executing them requires Postgres with the `vector` extension installed. This document does not claim a live or production deployment.

## Indexes

`CreateIndex` accepts optional `indexAlgorithm`:

| Algorithm | Default | pgvector statement |
|---|---|---|
| `hnsw` | yes | `USING hnsw (embedding <ops>)` with server defaults (`m = 16`, `ef_construction = 64`) |
| `ivfflat` | no | `USING ivfflat (embedding <ops>) WITH (lists = ivfflatLists)` |

`ivfflatLists` defaults to 100 and must be an integer from 1 to 32768. It is rejected for HNSW. Building IVFFlat before rows exist, and not running `REINDEX` after a bulk load, leaves recall unmeasured. This slice does not auto-reindex.

Distance metrics map to operator classes:

| `distanceMetric` | Operator | Opclass | Returned distance |
|---|---|---|---|
| `cosine` | `<=>` | `vector_cosine_ops` | cosine distance; `NaN` (zero vectors) is returned as `1` |
| `euclidean` | `<->` | `vector_l2_ops` | L2 distance |
| `dotproduct` | `<#>` | `vector_ip_ops` | `1 - inner_product` |

`ORDER BY` uses the raw operator so the ANN index is eligible. The dot-product adjustment is only in the selected distance.

Each index is a table `storage.vector_data_<32 hex chars>` with `embedding vector(N)`. Dimension `N` is 1 through 2000, which is the pgvector HNSW and IVFFlat limit. Higher dimensions are rejected. `halfvec`, `bit`, iterative index scans, and `hnsw.ef_search` / `ivfflat.probes` tuning are not configured. Metadata filters are SQL `WHERE` predicates on `jsonb`. Filtered recall can be lower than `topK` because iterative scans are off. That is still not an API-level exact scan.

`storage.vectors` remains a legacy JSONB import source. The first `PutVectors` or `QueryVectors` on an index that has no ANN relation assigns an id, copies those rows, and builds HNSW unless the index was created as IVFFlat. If `CREATE EXTENSION vector` or `CREATE INDEX` fails, the API returns `VectorExtensionUnavailable` or `VectorIndexNotAnn` and does not search those rows in process.

The product cap of 1,000,000 scalar values per index is unchanged.

## What is not ANN

`test_mock` is an in-memory contract harness used by unit tests. `GetIndex` reports `queryEngine: "exact-scan-harness"` and `annReady: false`. Its ranking uses the same distance formula as the API contract and is exact. Project refs use `queryEngine: "pgvector-ann"`.

## Embeddings and RAG

Vector Buckets do not embed text. `QueryVectors` rejects `queryText` or `text` with `EmbeddingProviderRequired`.

`POST /v1/embeddings` is the existing chat-proxy seam:

- It reads platform settings `ai_api_base`, `ai_api_key`, and `ai_embedding_model`.
- The model and URL come from those settings. Callers cannot substitute another endpoint.
- The call uses the outbound HTTP guard. The response limit for this call is 1 MiB.
- If any of those settings is missing, the response is **503** with `available: false`. No vector is synthesized.
- `LLM_ENDPOINT`, `LLM_API_KEY`, and `LLM_MODEL` are not an embedding provider and are not read.
- A successful response includes a `rag` object whose `retrievalExecuted` field is false. The caller passes `float32` to `QueryVectors`. There is no retrieval pipeline in this slice.

Application-owned `pgvector` tables and hybrid search stay on the SQL path documented in the CLI guide. Vector Buckets do not replace that path.
