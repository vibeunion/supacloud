# Application Platform Primitives

SupaCloud provides three project-scoped primitives for applications with private domain schemas, durable commands, and immutable generated artifacts. They are infrastructure mechanisms, not application business models.

## Custom PostgREST schemas

Projects can expose validated project-owned schemas in addition to the platform baseline:

```http
PATCH /v1/projects/:ref/config/postgrest
Authorization: Bearer <project-or-management-token>
Content-Type: application/json

{
  "exposed_schemas": ["api", "rpc"],
  "expected_revision": "<sha256-from-previous-read>"
}
```

The platform always keeps `public`, `storage`, and `graphql_public`. It adds `pgmq_public` only when the wrapper exists. Custom schemas:

- must already exist in the project database;
- are normalized to unique, sorted lowercase identifiers;
- cannot use PostgreSQL, Supabase, SupaCloud, Auth, Storage, Realtime, Vault, or PGMQ reserved names;
- are limited to 16 schemas;
- use an optimistic revision to prevent lost updates.

For a running project, a successful update renders and restarts the managed PostgREST generation. A paused runtime stores the new desired configuration and reports `restart_required=true`. An apply failure attempts to restore both the previous project configuration and the previous runtime generation.

Application migrations still own the schemas, views, grants, RLS policies, and RPC definitions. Removing a schema from `exposed_schemas` does not drop it.

## Transactional command receipts

`supacloud_commands` adds an idempotent command receipt on top of Durable Workflows. The public `supacloud_command_submit` and `supacloud_command_get` RPCs are service-role-only.

```ts
const receipt = await supacloud.commands.submit({
  commandId: crypto.randomUUID(),
  commandType: "report.issue",
  targetType: "report",
  targetId: reportId,
  actorId: userId,
  payload: { reportId },
  maxAttempts: 3,
});
```

For atomic business writes, call the private function from an application-owned `SECURITY DEFINER` RPC in the same PostgreSQL transaction:

```sql
update domain.reports
set status = 'issuing'
where id = p_report_id and status = 'approved';

perform supacloud_commands.submit(jsonb_build_object(
  'commandId', p_command_id,
  'commandType', 'report.issue',
  'targetType', 'report',
  'targetId', p_report_id,
  'actorId', auth.uid(),
  'payload', jsonb_build_object('reportId', p_report_id),
  'maxAttempts', 3
));
```

If either statement fails, PostgreSQL rolls back the domain write, receipt, workflow step, and PGMQ message together. Replaying the same command ID and payload returns `idempotent=true`; changing the command identity fields or payload returns an idempotency conflict.

Workers use `supacloud.workflows.claim()` and process workflow names beginning with `command.`. Completion, retry, failure, stale-attempt fencing, and events use the existing Durable Workflows API.

The application remains authoritative for approval rules, signing decisions, and domain status. SupaCloud owns only the execution receipt and delivery mechanics.

## Artifact registry

Upload the object to a private Storage bucket first, calculate its SHA-256 digest, then register the exact Storage object:

```ts
const artifact = await supacloud.artifacts.register({
  artifactId: crypto.randomUUID(),
  bucketId: "reports",
  objectPath: "2026/report-123.pdf",
  artifactType: "report.pdf",
  sha256,
  sizeBytes,
  mimeType: "application/pdf",
  retentionUntil: "2033-01-01T00:00:00Z",
  metadata: { reportId: "report-123", version: 4 },
});
```

Registration requires an existing `storage.objects` row and binds:

- Storage object ID, bucket, path, and object version;
- SHA-256, byte size, MIME type, and artifact type;
- optional creator, retention date, and application metadata.

Once registered, updates and deletion of the bound `storage.objects` row fail closed. Derived artifacts can record acyclic lineage:

```ts
await supacloud.artifacts.link({
  parentArtifactId: sourcePdfId,
  childArtifactId: ocrResultId,
  relationType: "derived_from",
});
```

The registry does not upload files, calculate hashes, infer OCR fields, or decide legal retention. Those remain application responsibilities.

## Security and rollback

- Public RPCs require `service_role`; never expose that key to browser or mobile clients.
- Private schemas and tables are not granted to `anon`, `authenticated`, or `service_role`.
- Command and workflow payloads are durable project data and must not contain credentials.
- Artifact metadata is immutable; create a new Storage object and artifact ID for a new version.
- Roll back application adoption by stopping new command submissions/workers and new artifact registrations. Keep the private ledgers for recovery and audit evidence.
- Removing custom PostgREST schemas is reversible and does not alter application schemas or data.
