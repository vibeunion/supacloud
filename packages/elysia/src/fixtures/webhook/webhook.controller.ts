import { Body, Controller, Get, Headers, Inject, Injectable, Param, Post, REQUEST_CONTEXT } from "@supacloud/app";
import { CommandError, commandIdentifier, decodeCommandIdentity } from "@supacloud/contracts";
import { WebhookInputSchema, WebhookReceiptSchema, WebhookKeySchema, WebhookLookupSchema } from "./contracts";
import { UpdateWebhook } from "./update.command";

function operationKey(value: unknown): string {
  try { return commandIdentifier(value); }
  catch { throw new CommandError("COMMAND_INPUT_INVALID"); }
}

@Injectable({ scope: "request" })
@Controller("/webhooks")
export class WebhookController {
  private readonly command: UpdateWebhook;
  constructor(@Inject(UpdateWebhook) command: unknown, @Inject(REQUEST_CONTEXT) private readonly context: unknown) {
    if (!(command instanceof UpdateWebhook)) throw new TypeError("Invalid webhook command");
    this.command = command;
  }
  @Post("/update", { body: WebhookInputSchema, response: WebhookReceiptSchema })
  update(@Body() input: unknown, @Headers("idempotency-key") key: unknown) {
    return this.command.execute(decodeCommandIdentity(this.context), operationKey(key), input);
  }
  @Get("/receipts/:key", { params: WebhookKeySchema, response: WebhookLookupSchema })
  async receipt(@Param("key") key: unknown) {
    return { receipt: await this.command.receipt(decodeCommandIdentity(this.context), operationKey(key)) };
  }
}
