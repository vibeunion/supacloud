# Release Control Automation and Headless Canary Specification

This specification defines platform-level mechanisms for automated application deployment, headless canary verification, batch function activations, and zero-downtime rollbacks across SupaCloud project instances.

## Background & Motivation

Downstream production applications (such as laboratory information management systems and enterprise backends) deployed onto SupaCloud require strict zero-downtime, deterministic verification, and atomic rollback guarantees.

Historically, client deployment runners had to orchestrate complex compensations around the management plane:
1. **Interactive Canary Friction**: To verify OAuth 2.1 S256 PKCE authorization and Edge Function JWKS verification without leaking static credentials, release controllers had to bind local loopback listeners (`127.0.0.1:$PORT/callback`) and wait for manual browser authorization or external browser automation.
2. **Sequential Function Deployment & Incomplete Rollback**: Deploying multi-function applications required sequential single-function CLI calls. On partial failure, client scripts had to execute manual reverse rollbacks, while the lack of CAS delete prevented safe cleanup of newly added functions.
3. **Secrets Management Without CAS Receipts**: Runtime secrets mutations lacked structured CAS receipts (`supacloud.cli.release-control.v1`), forcing fail-closed stops on network jitter or `OUTCOME_UNKNOWN`.
4. **Post-Migration Coordination Overhead**: Clients had to manually restart PostgREST, poll status endpoints, and execute application table probes to ensure schema cache reload completed.

This specification outlines the platform primitives and CLI interfaces to resolve these friction points natively.

---

## 1. Headless OAuth 2.1 / PKCE Canary Verification

To validate authorization server discovery, token exchange, and Edge Function JWT/JWKS claim verification in automated CI/CD and production release pipelines without human browser interaction or static long-lived tokens.

### Control Plane Probe API

```http
POST /v1/projects/:ref/auth/canary/probe
Authorization: Bearer <management-api-token>
Content-Type: application/json

{
  "client_id": "supacloud-release-canary",
  "expected_subject": "11111111-1111-4111-8111-111111111111",
  "scope": "openid email profile",
  "code_challenge_method": "S256",
  "test_invalid_verifier": true,
  "target_function_slug": "fa-access-context"
}
```

### Response Receipt

```json
{
  "schema": "supacloud.cli.release-control.v1",
  "ok": true,
  "operation": "auth.canary_probe",
  "project_ref": "vxmnblbzsxzutzrjntyu",
  "timestamp": "2026-08-20T10:00:00.000Z",
  "data": {
    "invalid_verifier_rejected": true,
    "token_exchange_status": 200,
    "target_function_status": 200,
    "duration_ms": 42.5,
    "subject_matched": true
  }
}
```

### CLI Command

```bash
supacloud-cli auth canary-probe \
  --ref "$PROJECT_REF" \
  --subject "$CANARY_SUBJECT" \
  --function "fa-access-context" \
  --test-invalid-verifier
```

---

## 2. Atomic Release Manifest & Multi-Function Batch Activation

Enables applications with multiple Edge Functions to deploy, activate, and roll back atomically as a single release unit.

### Release Manifest Schema (`deploy-manifest.json`)

```json
{
  "contractVersion": "2026-08-20.1",
  "product": "enterprise-app",
  "functions": [
    { "slug": "app-access-context", "entrypoint": "functions/app-access-context/index.ts", "verifyJwt": false },
    { "slug": "app-api", "entrypoint": "functions/app-api/index.ts", "verifyJwt": false },
    { "slug": "app-worker", "entrypoint": "functions/app-worker/index.ts", "verifyJwt": false },
    { "slug": "app-worker-scheduled", "entrypoint": "functions/app-worker-scheduled/index.ts", "verifyJwt": true }
  ],
  "scheduledFunctions": [
    { "slug": "app-worker-scheduled", "cron": "*/5 * * * *", "method": "POST" }
  ]
}
```

### Batch Deployment Command

```bash
supacloud-cli edge_functions deploy_manifest \
  --ref "$PROJECT_REF" \
  --manifest deploy-manifest.json \
  --bundles-dir ./dist/functions \
  --atomic
```

### Execution Semantics
- **Pre-Activation Inventory**: Checks existing active versions and SHA-256 hashes for all declared functions.
- **Atomic Activation**: Activates all updated functions in a single transactional state update.
- **Automatic Rollback**: If any function fails its startup health check (`probeFunctionStartup`), all functions in the batch automatically revert to their pre-deployment active versions without leaving partial rollouts.

### Compare-And-Set (CAS) Function Deletion

```bash
supacloud-cli edge_functions delete \
  --ref "$PROJECT_REF" \
  --slug "legacy-function" \
  --expected-active-version "1.2.0" \
  --expected-activation-id "22222222-2222-4222-8222-222222222222"
```

Prevents race conditions where a concurrently updated function is deleted accidentally.

---

## 3. Versioned Secrets Management with CAS Receipts

Guarantees safe runtime environment variable updates with optimistic concurrency control and structured audit receipts.

### Upsert Command with Revision Checks

```bash
supacloud-cli secrets upsert \
  --ref "$PROJECT_REF" \
  --from-env "FA_ALLOWED_ORIGINS,FA_WORKER_SECRET" \
  --expected-digest "<sha256-of-current-secret-names>"
```

### Structured Receipt (`supacloud.cli.release-control.v1`)

```json
{
  "schema": "supacloud.cli.release-control.v1",
  "ok": true,
  "operation": "secrets.upsert",
  "project_ref": "vxmnblbzsxzutzrjntyu",
  "updated_count": 2,
  "total_count": 14,
  "secrets_digest": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "updated_at": "2026-08-20T10:05:00.000Z"
}
```

---

## 4. Post-Migration Schema Cache Refresh & Synchronization

Eliminates manual PostgREST restarts and ad-hoc table probing by coordinating database migrations with the API gateway schema cache.

### Automatic Coordination Flow

1. `supacloud-cli database push_migrations` executes migrations inside a transaction.
2. Upon commit, the migration worker issues `NOTIFY pgrst, 'reload schema'` to the project's dedicated PostgREST instance.
3. The platform control plane probes PostgREST internal readiness (`/`) until the schema cache generation matches the post-migration state.
4. The migration receipt reports `schema_reloaded=true` and `postgrest_healthy=true`.

---

## 5. Versioned Frontend Hosting & Instant Rollbacks

Provides immutable artifact retention and instant zero-reupload rollbacks for SupaCloud Pages.

### Commands

```bash
# Upload a prebuilt immutable release
supacloud-cli frontend upload_release \
  --ref "$PROJECT_REF" \
  --id "$DEPLOYMENT_ID" \
  --zip_path ./app/build.zip

# Activate a previously uploaded release with compare-and-swap protection
supacloud-cli frontend activate_release \
  --ref "$PROJECT_REF" \
  --id "$DEPLOYMENT_ID" \
  --release_id "$RELEASE_SHA256" \
  --expected_active_release_id "$CURRENT_RELEASE_SHA256_OR_ABSENT" \
  --expected_activation_id "$CURRENT_ACTIVATION_UUID_OR_ABSENT" \
  --mutation_id "$RETRY_STABLE_UUID_V4"
```

---

## Benefits & Impact

| Capability | Previous Client Workaround | Native SupaCloud Primitive |
| :--- | :--- | :--- |
| **PKCE Auth Canary** | Local loopback HTTP listener + browser consent | Native headless `auth canary-probe` API/CLI |
| **Multi-Function Deploy** | Sequential CLI calls + client reverse rollback loop | `edge_functions deploy_manifest --atomic` |
| **Function Cleanup** | Manual dashboard deletion (no CLI CAS delete) | `edge_functions delete --expected-version ...` |
| **Secrets Update** | Blind upsert without mutation receipt | CAS-checked `secrets upsert` with revision receipt |
| **Schema Reload** | Manual `postgrest_restart` + client table polling | Native reload notification & status confirmation |
| **Frontend Rollback** | Client re-compilation and re-upload of old zip | Instant immutable release activation by SHA-256 with CAS |
