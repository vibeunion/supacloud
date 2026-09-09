import { Command, Inject, Injectable } from "@supacloud/app";
import { CommandError, type CommandIdentity } from "@supacloud/contracts";
import { createTransactionalCommand, plaintextCommandInput } from "@supacloud/commands";
import { decodeWebhookInput } from "./contracts";
import { WEBHOOK_ENVIRONMENT, WebhookEnvironment } from "./environment";

@Injectable()
@Command({
  name: "webhook.update.v1", permission: "webhook.update", rpc: "webhookUpdate",
  transaction: "required", audit: "webhook.updated", idempotency: "required",
})
export class UpdateWebhook {
  private readonly executor;
  constructor(@Inject(WEBHOOK_ENVIRONMENT) environment: unknown) {
    if (!(environment instanceof WebhookEnvironment)) throw new TypeError("Invalid webhook environment");
    this.executor = createTransactionalCommand({
      store: environment.store, name: "webhook.update.v1", inputCodec: plaintextCommandInput,
      input: decodeWebhookInput, result: decodeWebhookInput,
      authorize: (identity, _input, tx) => environment.authorize(identity, tx),
      execute: async (tx, input, identity) => {
        const rows = await tx.query(`UPDATE public.webhook_module_example
          SET enabled=$3,writes=writes+1 WHERE tenant_id=$1 AND id=$2 RETURNING id,enabled`,
        [identity.tenantId, input.id, input.enabled]);
        if (!Array.isArray(rows) || rows.length !== 1) throw new CommandError("COMMAND_REJECTED");
        const row: unknown = rows[0];
        return decodeWebhookInput(row);
      },
      audit: {
        event: "webhook.updated", details: (input) => ({ webhookId: input.id }),
        write: (tx) => environment.writeAudit(tx),
      },
    });
  }
  execute(identity: CommandIdentity, key: string, input: unknown) {
    return this.executor.execute(identity, key, input);
  }
  receipt(identity: CommandIdentity, key: string) {
    return this.executor.lookupByReference(identity, key);
  }
}
