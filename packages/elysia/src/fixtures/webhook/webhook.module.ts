import { Module } from "@supacloud/app";
import { UpdateWebhook } from "./update.command";
import { WebhookController } from "./webhook.controller";

@Module({ name: "webhook", providers: [UpdateWebhook], controllers: [WebhookController], commands: [UpdateWebhook] })
export class WebhookModule {}
