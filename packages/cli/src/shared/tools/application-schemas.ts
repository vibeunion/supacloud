import * as Delivery from "@supacloud/delivery";

// CLI argument decoding and delivery now share TypeBox 1.x, so the delivery
// schemas are re-exported directly instead of being wrapped in a 0.34 custom kind.
export const ApplicationIdSchema = Delivery.ApplicationIdSchema;
export const ApplicationReleaseIdSchema = Delivery.ApplicationReleaseIdSchema;
export const ApplicationReleaseRecordSchema = Delivery.ApplicationReleaseRecordSchema;
export const ApplicationConfigurationIdSchema = Delivery.ApplicationConfigurationIdSchema;
export const ApplicationActivationIdSchema = Delivery.ApplicationActivationIdSchema;
export const ApplicationActivationWriteSchema = Delivery.ApplicationActivationWriteSchema;
export const ApplicationActivationResultSchema = Delivery.ApplicationActivationResultSchema;
export const ApplicationActivationRetirementResultSchema = Delivery.ApplicationActivationRetirementResultSchema;