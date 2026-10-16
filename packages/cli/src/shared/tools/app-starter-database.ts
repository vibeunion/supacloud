export const STARTER_DATABASE_CONFIG = {
  version: 1,
  schema: ["db/schema.ts"],
  functions: "db/functions",
  migrations: "migrations",
  contracts: "db/contracts",
  audit: "output/database-audit",
  consumers: ["src", "scripts", "tests"],
  auditConsumers: [],
  role: "starter_review_http",
};

export const STARTER_DATABASE_SCHEMA = `import { sql } from "drizzle-orm";
import { boolean, check, integer, jsonb, pgTable, primaryKey, text, unique, uuid } from "drizzle-orm/pg-core";

// Structure for the reviewed starter migrations. Grants/policies stay in those migrations.
export const application = pgTable.withRLS("starter_application", {
  singleton: boolean().default(true).primaryKey(),
  projectId: text("project_id").notNull(),
  tenantId: text("tenant_id").notNull(),
}, table => [
  check("starter_application_singleton_check", sql\`\${table.singleton}\`),
  check("starter_application_project_id_check", sql\`length(\${table.projectId}) > 0\`),
  check("starter_application_tenant_id_check", sql\`length(\${table.tenantId}) > 0\`),
]);

export const reviews = pgTable.withRLS("starter_reviews", {
  id: text().primaryKey(),
  ownerId: text("owner_id").notNull(),
  state: text({ enum: ["draft", "approved"] }).notNull(),
  version: integer().notNull(),
}, table => [
  check("starter_reviews_state_check", sql\`\${table.state} IN ('draft', 'approved')\`),
  check("starter_reviews_version_check", sql\`\${table.version} > 0\`),
]);

export const members = pgTable.withRLS("starter_members", {
  subject: text().primaryKey(),
  enabled: boolean().default(true).notNull(),
  canApprove: boolean("can_approve").default(false).notNull(),
  storageSubject: uuid("storage_subject").unique(),
});

export const attachments = pgTable.withRLS("starter_attachments", {
  reviewId: text("review_id").primaryKey().references(() => reviews.id),
  artifactId: uuid("artifact_id").notNull().unique(),
  ownerId: text("owner_id").notNull(),
  runId: uuid("run_id").notNull().unique(),
  objectPath: text("object_path").notNull().unique(),
});

export const attachmentResults = pgTable.withRLS("starter_attachment_results", {
  reviewId: text("review_id").notNull().references(() => reviews.id),
  version: integer().notNull(),
  artifactId: uuid("artifact_id").notNull(),
  result: jsonb().$type<unknown>().notNull(),
}, table => [
  primaryKey({ columns: [table.reviewId, table.version, table.artifactId] }),
  check("starter_attachment_results_version_check", sql\`\${table.version} >= 2\`),
]);

export const attachmentRetries = pgTable.withRLS("starter_attachment_retries", {
  runId: uuid("run_id").primaryKey(),
  reviewId: text("review_id").notNull().references(() => attachments.reviewId),
  previousRunId: uuid("previous_run_id").notNull().unique(),
  generation: integer().notNull(),
}, table => [
  unique("starter_attachment_retries_review_id_generation_key").on(table.reviewId, table.generation),
  check("starter_attachment_retries_generation_check", sql\`\${table.generation} > 0\`),
  check("starter_attachment_retries_check", sql\`\${table.runId} <> \${table.previousRunId}\`),
]);

export type ReviewRow = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
`;

export const STARTER_DATABASE_MODULES = `import { defineDatabaseModule } from "@supacloud/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import { application, reviews, members, attachments, attachmentResults, attachmentRetries } from "./schema";

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
  tables: [application, reviews, members, attachments, attachmentResults, attachmentRetries].map(table => {
    const config = getTableConfig(table);
    return (config.schema ?? "public") + "." + config.name;
  }),
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
## Database Source Workflow

Drizzle owns table declarations and inferred row types in db/schema.ts.
Use the existing @supacloud/db/drizzle-bun adapters for typed queries and governed
transactions; never replace permission, idempotency or audit checks with plain CRUD.
Opaque JSON still needs runtime decoding.

After installing dependencies, run \`bun run db:generate\` once and commit db/contracts/.
The default \`bun run check\` and build fail on stale database contracts before any
compiler regeneration. After an intentional source change, run db:generate again,
review the diff, then run check.
The command starter registers databaseGovernance.moduleFile = "db/modules.ts" and
keeps the default \`databaseGovernance.mode = "check"\`: compile/check/build run
the offline source-contract gate without a database. Use \`bun run dev:integration\`
with the CLI's explicit loopback database URL, or set databaseGovernance.mode to
"enforce" with an explicitly supplied \`DATABASE_URL\`, to run SQL lint and live
Catalog reconciliation. Missing connections, stale source contracts and Catalog
drift fail closed; no contracts or migrations are silently regenerated.

- Maintain one schema-qualified function with explicit grants per db/functions/*.sql.
- Preserve migrations/ and its existing executor/ledger. Add forward migrations only.
- \`bun run db:diff\` generates Drizzle drafts under db/migration-candidates/, never
  into the deployment directory. The starter has existing SQL history, so establish
  and review a matching Drizzle baseline before promoting any draft; the first
  draft is not automatically an incremental production migration.
- \`bun run db:pull\` requires an explicitly selected DATABASE_URL and writes only
  output/database-audit/drizzle-candidate/. Review candidates; never overwrite source blindly.
- Full SQL dumps belong under the ignored output/database-audit/ directory. They are
  audit/recovery artifacts, never ordinary type, application or test inputs.
- \`bun run db:assess\` explains adoption/findings without writing or connecting.
- GraphQL/PostgREST exports remain legitimate protocol contracts. This check is not
  proof of deployed schema, effective role permissions or complete RLS equivalence.

Do not introduce any/@ts-ignore to bypass a contract. Use Drizzle-inferred types,
preserve bigint/numeric precision and decode unknown results at the boundary.
`;

export function starterDatabaseFiles(): Record<string, string> {
  return {
    "database.sources.json": JSON.stringify(STARTER_DATABASE_CONFIG, null, 2) + "\n",
    "db/schema.ts": STARTER_DATABASE_SCHEMA,
    "db/modules.ts": STARTER_DATABASE_MODULES,
    "tests/database-governance.sql": STARTER_DATABASE_TEST,
    "db/functions/README.md": "Maintain one schema-qualified function and its explicit EXECUTE ACL per SQL file. No RPC functions are needed by the initial transactional starter.\n",
    "drizzle.config.ts": `import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./db/migration-candidates",
});
`,
    "drizzle.pull.config.ts": `import { defineConfig } from "drizzle-kit";
const url = process.env["DATABASE_URL"];
if (!url) throw new Error("Select an explicit DATABASE_URL for introspection");
export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./output/database-audit/drizzle-candidate",
  dbCredentials: { url },
});
`,
  };
}
