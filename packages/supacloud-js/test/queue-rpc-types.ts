import type {
  SupaCloudQueueJson, SupaCloudQueueMessage, SupaCloudQueueSendResult, SupaCloudQueueMutationResult,
} from "../src/queue-rpc.js";

declare const message: SupaCloudQueueMessage;
declare const sent: SupaCloudQueueSendResult;
declare const mutation: SupaCloudQueueMutationResult;
const ids: string[] = [message.msg_id, sent.msg_id, mutation.msg_id];
const valid: SupaCloudQueueJson[] = [null, 1, "text", true, { list: [null, 2] }];
// @ts-expect-error Integer IDs are not exposed as JavaScript numbers.
const numeric: number = message.msg_id;
// @ts-expect-error JSON messages cannot contain undefined properties.
const invalid: SupaCloudQueueJson = { missing: undefined };
// @ts-expect-error Private transport properties are not part of a message.
void message.raw;
void [ids, valid, numeric, invalid];
