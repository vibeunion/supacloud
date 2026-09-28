import { Kind, Type, TypeRegistry } from "@sinclair/typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import * as Delivery from "@supacloud/delivery";

// CLI argument decoding still uses TypeBox 0.34. Keep delivery's TypeBox 1
// schemas intact and delegate validation through the supported custom-kind API.
const deliveryKind = "SupaCloudDeliveryContract";
TypeRegistry.Set(deliveryKind, (schema, value) => Value.Check(schema as TSchema, value));

function contract<T extends TSchema>(schema: T) {
  return Type.Unsafe<Static<T>>({ ...schema, [Kind]: deliveryKind });
}

export const ApplicationIdSchema = contract(Delivery.ApplicationIdSchema);
export const ApplicationReleaseIdSchema = contract(Delivery.ApplicationReleaseIdSchema);
export const ApplicationReleaseRecordSchema = contract(Delivery.ApplicationReleaseRecordSchema);
export const ApplicationConfigurationIdSchema = contract(Delivery.ApplicationConfigurationIdSchema);
export const ApplicationActivationIdSchema = contract(Delivery.ApplicationActivationIdSchema);
export const ApplicationActivationWriteSchema = contract(Delivery.ApplicationActivationWriteSchema);
export const ApplicationActivationResultSchema = contract(Delivery.ApplicationActivationResultSchema);
export const ApplicationActivationRetirementResultSchema = contract(Delivery.ApplicationActivationRetirementResultSchema);
