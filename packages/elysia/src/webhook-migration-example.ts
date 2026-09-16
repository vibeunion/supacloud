import type { CommandAuthorization, CommandIdentity } from "@supacloud/contracts";
import { createPostgresCommandStore, type CommandDatabase, type CommandTransaction } from "@supacloud/db";
import { createApplication } from "./index";
import { WebhookEnvironment } from "./fixtures/webhook/environment";
import { createCompiledModules } from "./fixtures/webhook-generated/application";

export { decodeWebhookInput } from "./fixtures/webhook/contracts";
export const WEBHOOK_EXAMPLE_SQL = `CREATE TABLE IF NOT EXISTS public.webhook_module_example (
  tenant_id text NOT NULL, id text NOT NULL, enabled boolean NOT NULL,
  writes integer NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id,id)
);`;

/** Composition only; the compiler generates factories and routes from the real module. */
export function createWebhookMigrationExample(options: {
  database: CommandDatabase;
  authenticate(request: Request): Promise<CommandIdentity>;
  authorize(identity: CommandIdentity, transaction: CommandTransaction): Promise<CommandAuthorization>;
  writeAudit?(transaction: CommandTransaction): Promise<void>;
}) {
  const environment = new WebhookEnvironment(
    createPostgresCommandStore(options.database), options.authorize,
    async (tx) => { await options.writeAudit?.(tx); },
  );
  const modules = createCompiledModules();
  const app = createApplication({
    modules, normalize: false, deps: { webhookEnvironment: environment },
    requestContext: options.authenticate,
  });
  return { app, modules };
}
