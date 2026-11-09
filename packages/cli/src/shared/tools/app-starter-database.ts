export const STARTER_DATABASE_CONFIG = {
  version: 1,
  schema: ["zenstack/schema.zmodel", "zenstack/generated/schema.ts", "db/schema.ts"],
  functions: "db/functions",
  migrations: "migrations",
  contracts: "db/contracts",
  audit: "output/database-audit",
  consumers: ["src", "scripts", "tests"],
  auditConsumers: [],
  trustedHosts: ["src/host", "src/delivery-host.ts", "src/delivery-worker.ts"],
  role: "starter_review_http",
};

export const STARTER_DATABASE_MODEL = `datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}
plugin policy {
  provider = "@zenstackhq/plugin-policy"
}
type Principal {
  id String
  canApprove Boolean
  @@auth()
}
model Application {
  singleton Boolean @id @default(true)
  projectId String @map("project_id")
  tenantId String @map("tenant_id")
  @@map("starter_application")
  @@allow("read", auth() != null)
}
model Review {
  id String @id
  ownerId String @map("owner_id")
  state String
  version Int
  attachment Attachment?
  results AttachmentResult[]
  @@map("starter_reviews")
  @@allow("read", auth() != null && (ownerId == auth().id || auth().canApprove))
}
model Member {
  subject String @id
  enabled Boolean @default(true)
  canApprove Boolean @default(false) @map("can_approve")
  storageSubject String? @unique @db.Uuid @map("storage_subject")
  @@map("starter_members")
  @@allow("read", auth() != null && subject == auth().id)
}
model Attachment {
  reviewId String @id @map("review_id")
  review Review @relation(fields: [reviewId], references: [id])
  artifactId String @unique @db.Uuid @map("artifact_id")
  ownerId String @map("owner_id")
  runId String @unique @db.Uuid @map("run_id")
  objectPath String @unique @map("object_path")
  retries AttachmentRetry[]
  @@map("starter_attachments")
  @@allow("read", auth() != null && ownerId == auth().id)
}
model AttachmentResult {
  reviewId String @map("review_id")
  review Review @relation(fields: [reviewId], references: [id])
  version Int
  artifactId String @db.Uuid @map("artifact_id")
  result Json
  @@id([reviewId, version, artifactId])
  @@map("starter_attachment_results")
  @@allow("read", auth() != null && review.ownerId == auth().id)
}
model AttachmentRetry {
  runId String @id @db.Uuid @map("run_id")
  reviewId String @map("review_id")
  attachment Attachment @relation(fields: [reviewId], references: [reviewId])
  previousRunId String @unique @db.Uuid @map("previous_run_id")
  generation Int
  @@unique([reviewId, generation])
  @@map("starter_attachment_retries")
  @@allow("read", auth() != null && attachment.ownerId == auth().id)
}
`;

export const STARTER_DATABASE_SCHEMA = `export type { Review as ReviewRow, Attachment as AttachmentRow, AttachmentRetry as AttachmentRetryRow } from "../zenstack/generated/models";
import type { Review } from "../zenstack/generated/models";
export type NewReview = Review;
`;

export const STARTER_DATABASE_MODULES = `import { defineDatabaseModule } from "@supacloud/db";

const backendPolicies = [
  ["starter_backend_binding_read", "public.starter_application", "select", ["starter_review_http", "starter_review_worker"]],
  ["starter_backend_binding_lock", "public.starter_application", "update", ["starter_review_http", "starter_review_worker"]],
  ["starter_backend_binding_immutable", "public.starter_application", "update", ["starter_review_http", "starter_review_worker"]],
  ["starter_backend_member_read", "public.starter_members", "select", ["starter_review_http", "starter_review_worker"]],
  ["starter_backend_member_lock", "public.starter_members", "update", ["starter_review_http", "starter_review_worker"]],
  ["starter_backend_member_immutable", "public.starter_members", "update", ["starter_review_http", "starter_review_worker"]],
  ["starter_backend_review_read", "public.starter_reviews", "select", ["starter_review_http", "starter_review_worker"]],
  ["starter_backend_review_update", "public.starter_reviews", "update", ["starter_review_http"]],
  ["starter_worker_review_immutable", "public.starter_reviews", "update", ["starter_review_worker"]],
  ["starter_backend_attachment_read", "public.starter_attachments", "select", ["starter_review_http", "starter_review_worker"]],
  ["starter_backend_attachment_lock", "public.starter_attachments", "update", ["starter_review_http", "starter_review_worker"]],
  ["starter_backend_attachment_immutable", "public.starter_attachments", "update", ["starter_review_http", "starter_review_worker"]],
  ["starter_http_attachment_insert", "public.starter_attachments", "insert", ["starter_review_http"]],
  ["starter_worker_result_read", "public.starter_attachment_results", "select", ["starter_review_worker"]],
  ["starter_worker_result_insert", "public.starter_attachment_results", "insert", ["starter_review_worker"]],
] as const;

// The module is the single live-Catalog ownership contract for starter tables.
export default defineDatabaseModule({
  name: "starter",
  tables: ["public.starter_application", "public.starter_reviews", "public.starter_members", "public.starter_attachments", "public.starter_attachment_results", "public.starter_attachment_retries"],
  policies: [
    ...([
      ["starter_http_retry_read", "select", "starter_review_http"],
      ["starter_http_retry_insert", "insert", "starter_review_http"],
      ["starter_worker_retry_read", "select", "starter_review_worker"],
    ] as const).map(([name, operation, role]) => ({
      name, table: "public.starter_attachment_retries", operation, roles: [role],
      source: "migrations/005-review-task-recovery.sql", tests: ["tests/database-governance.sql"],
    })),
    ...backendPolicies.map(([name, table, operation, roles]) => ({
      name, table, operation, roles: [...roles], source: "migrations/004-review-runtime-roles.sql",
      tests: ["tests/database-governance.sql"],
    })),
    {
      name: "starter_member_read", table: "public.starter_members", operation: "select",
      roles: ["authenticated"], source: "migrations/003-review-uploads.sql",
      tests: ["tests/database-governance.sql"],
    },
    {
      name: "starter_review_read", table: "public.starter_reviews", operation: "select",
      roles: ["authenticated"], source: "migrations/003-review-uploads.sql",
      tests: ["tests/database-governance.sql"],
    },
  ],
});
`;

export const STARTER_DATABASE_TEST = `-- Read-only catalog assertions; behavioral authorization tests remain separate.
BEGIN READ ONLY;
DO $test$
DECLARE
  owned text[] := ARRAY['starter_application','starter_reviews','starter_members',
    'starter_attachments','starter_attachment_results','starter_attachment_retries'];
BEGIN
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY(owned) AND c.relrowsecurity) <> 6 THEN
    RAISE EXCEPTION 'All starter tables must exist with RLS enabled';
  END IF;
  IF (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY(owned)) <> 20 THEN
    RAISE EXCEPTION 'Starter policy inventory changed; reconcile db/modules.ts';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('starter_review_http','starter_review_worker')
      AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Starter roles must not bypass row security';
  END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('starter_review_http','starter_review_worker')) <> 2 THEN
    RAISE EXCEPTION 'Starter runtime roles are missing';
  END IF;
END
$test$;
ROLLBACK;
`;

export const STARTER_DATABASE_GUIDE = `
## Model and migration workflow

Maintain zenstack/schema.zmodel. Run \`bun run db:generate\` to compile model and RPC
contracts; commit generated types with their sources. Do not introduce any/@ts-ignore
to bypass model or contract diagnostics. \`bun run db:check\` compares
fresh generation without writing files or opening a database. Model read policies
complement existing database RLS; command writes still use the shared transaction,
receipt and audit boundary, not unrestricted CRUD. SQL constraints, RPCs and RLS
remain explicit reviewed migrations when the model language cannot express them.

Use \`bun run db:diff -- --candidate output/database-audit/change.sql\` with an
explicit read-only SUPACLOUD_MODEL_DATABASE_URL. Review the SQL, then promote a new
forward migration through the existing SupaCloud plan/apply ledger. Never run
zen migrate deploy or db push against a managed production database.
\`bun run db:pull -- --candidate output/database-audit/schema.zmodel\` writes a
review candidate only; it never overwrites the maintained model. Add policies
before adopting introspection output. Keep one migration history and preserve RLS.

Adopting a database that has no model yet starts with the same command: pull
introspects through a temporary datasource-only model, so no hand-written ZModel
is required. Review the candidate, add the policy plugin and @@allow rules, move
it to zenstack/schema.zmodel, then run \`bun run db:generate\`. Until that file
exists, \`db:diff\` and \`db:generate\` fail closed instead of building from an
unreviewed introspection result. Keep the host wiring unchanged: one
createZenStackDatabase composition root supplies read-only models and the
transactional command store.
`;

export function starterDatabaseFiles(): Record<string, string> {
  return {
    "database.sources.json": JSON.stringify(STARTER_DATABASE_CONFIG, null, 2) + "\n",
    "db/schema.ts": STARTER_DATABASE_SCHEMA,
    "db/modules.ts": STARTER_DATABASE_MODULES,
    "tests/database-governance.sql": STARTER_DATABASE_TEST,
    "db/functions/README.md": "Maintain one schema-qualified function and its explicit EXECUTE ACL per SQL file. No RPC functions are needed by the initial transactional starter.\n",
    "zenstack/schema.zmodel": STARTER_DATABASE_MODEL,
  };
}
