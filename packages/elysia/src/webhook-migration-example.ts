import { decodeCommandIdentity, type CommandAuthorization, type CommandIdentity } from "@supacloud/contracts";
import { createPostgresCommandStore, type CommandDatabase, type CommandTransaction } from "@supacloud/db";
import { ApplicationError, createApplication, type CommandExecutor } from "./index";
import { createPersistentCommandAdapter } from "./persistent-command";
import { WebhookEnvironment } from "./fixtures/webhook/environment";
import { UpdateWebhook } from "./fixtures/webhook/update.command";
import { createCompiledModules } from "./fixtures/webhook-generated/application";

export { decodeWebhookInput } from "./fixtures/webhook/contracts";
export const WEBHOOK_EXAMPLE_SQL = `CREATE TABLE IF NOT EXISTS public.webhook_module_example (
  tenant_id text NOT NULL, id text NOT NULL, enabled boolean NOT NULL,
  writes integer NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id,id)
);`;

/**
 * Register the existing native command boundary, not a pass-through executor.
 * Controllers still call their generated UpdateWebhook service directly. Any
 * explicit command invocation delegates to that same service, which owns
 * authorization, durable receipts, transactions and audit. Never run a second
 * route continuation or construct another command runtime here.
 */
export const executeWebhookCommand: CommandExecutor = async (invocation) => {
  const descriptor = invocation.command;
  const command = invocation.services.updateWebhook;
  if (descriptor.className !== "UpdateWebhook" || descriptor.name !== "webhook.update.v1"
    || descriptor.rpc !== "webhookUpdate" || descriptor.permission !== "webhook.update"
    || descriptor.transaction !== "required" || descriptor.idempotency !== "required"
    || descriptor.audit !== "webhook.updated" || !(command instanceof UpdateWebhook)) {
    throw new ApplicationError("Webhook command binding is invalid", { code: "COMMAND_NOT_REGISTERED" });
  }
  return createPersistentCommandAdapter({
    kind: "transactional",
    execute: (identity, key, input) => command.execute(identity, key, input),
  }, {
    identity: (current) => decodeCommandIdentity(current.requestContext),
    input: (current) => current.input.body,
  }).execute(invocation);
};

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
    commandExecutor: executeWebhookCommand,
  });
  return { app, modules };
}
