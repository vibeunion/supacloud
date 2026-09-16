import { InjectionToken } from "@supacloud/app";
import type { CommandAuthorization, CommandIdentity } from "@supacloud/contracts";
import type { CommandStore } from "@supacloud/commands";
import type { CommandTransaction } from "@supacloud/db";

export class WebhookEnvironment {
  constructor(
    readonly store: CommandStore<CommandTransaction>,
    readonly authorize: (identity: CommandIdentity, tx: CommandTransaction) => Promise<CommandAuthorization>,
    readonly writeAudit: (tx: CommandTransaction) => Promise<void>,
  ) {}
}
export const WEBHOOK_ENVIRONMENT = new InjectionToken<WebhookEnvironment>("webhook.environment");
