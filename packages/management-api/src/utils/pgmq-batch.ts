import { PgmqInputError, PgmqPayloadTooLargeError } from "./pgmq-input";
import { serializePgmqPayload, PGMQ_BATCH_BYTES, PGMQ_BATCH_NODES } from "./pgmq-payload";

export function capturePgmqBatch(value: unknown): string[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new PgmqInputError();
    const array: object = value;
    const properties = Object.getOwnPropertyDescriptors(array);
    const length: unknown = properties.length?.value;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > 10000
      || Reflect.ownKeys(properties).length !== length + 1) throw new PgmqInputError();
    const result: string[] = [];
    const budget = { remainingBytes: PGMQ_BATCH_BYTES, remainingNodes: PGMQ_BATCH_NODES };
    for (let index = 0; index < length; index++) {
      const property = properties[String(index)];
      if (!property || !("value" in property)) throw new PgmqInputError();
      const message: unknown = property.value;
      result.push(serializePgmqPayload(message, budget));
    }
    return result;
  } catch (error) {
    if (error instanceof PgmqPayloadTooLargeError) throw error;
    throw new PgmqInputError();
  }
}
