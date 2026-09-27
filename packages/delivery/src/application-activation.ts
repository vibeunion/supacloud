import { Type, type Static } from "typebox";
import { ApplicationConfigurationIdSchema } from "./application-configuration";
import { ApplicationIdSchema, ApplicationReleaseIdSchema } from "./application-release";

export const ApplicationActivationIdSchema = ApplicationConfigurationIdSchema;
export const ApplicationActivationWriteSchema = Type.Object({
  activation_id: ApplicationActivationIdSchema,
  release_id: ApplicationReleaseIdSchema,
  configuration_id: ApplicationConfigurationIdSchema,
  expected_activation_id: Type.Union([ApplicationActivationIdSchema, Type.Null()]),
}, { additionalProperties: false });

export const ApplicationActivationResultSchema = Type.Object({
  project_ref: Type.String({ pattern: "^[a-z0-9-]{1,20}$" }),
  application_id: ApplicationIdSchema,
  environment_id: ApplicationIdSchema,
  release_id: ApplicationReleaseIdSchema,
  activation_id: ApplicationActivationIdSchema,
  replayed: Type.Boolean(),
}, { additionalProperties: false });
export const ApplicationActivationRetirementResultSchema = Type.Object({
  project_ref: Type.String({ pattern: "^[a-z0-9-]{1,20}$" }),
  application_id: ApplicationIdSchema,
  environment_id: ApplicationIdSchema,
  activation_id: ApplicationActivationIdSchema,
  retired_at: Type.String(),
}, { additionalProperties: false });

export type ApplicationActivationWrite = Static<typeof ApplicationActivationWriteSchema>;
export type ApplicationActivationResult = Static<typeof ApplicationActivationResultSchema>;
export type ApplicationActivationRetirementResult = Static<typeof ApplicationActivationRetirementResultSchema>;
