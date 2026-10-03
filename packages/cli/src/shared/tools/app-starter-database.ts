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
import { boolean, check, integer, jsonb, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";

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

export type ReviewRow = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
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
review the diff, then run check. Ordinary checks are offline.

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
    "db/functions/README.md": "Maintain one schema-qualified function and its explicit EXECUTE ACL per SQL file. No RPC functions are needed by the initial transactional starter.\n",
    "drizzle.config.ts": `import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./db/migration-candidates",
});
`,
    "drizzle.pull.config.ts": `import { defineConfig } from "drizzle-kit";
const url = process.env.DATABASE_URL;
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
