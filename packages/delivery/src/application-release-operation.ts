import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ApplicationActivationIdSchema } from "./application-activation";
import {
  ApplicationConfigurationIdSchema, ApplicationConfigurationWriteSchema,
} from "./application-configuration";
import { ApplicationIdSchema, ApplicationReleaseIdSchema } from "./application-release";

const closed = { additionalProperties: false } as const;
const nullableActivation = Type.Union([ApplicationActivationIdSchema, Type.Null()]);

export const ApplicationReleaseRequestSchema = Type.Object({
  release_id: ApplicationReleaseIdSchema,
  configuration_id: Type.Optional(ApplicationConfigurationIdSchema),
  configuration_write: Type.Optional(ApplicationConfigurationWriteSchema),
  activation_id: Type.Optional(ApplicationActivationIdSchema),
  expected_activation_id: Type.Optional(nullableActivation),
  expected_plan_sha256: Type.Optional(ApplicationReleaseIdSchema),
}, closed);

export const ApplicationReleaseResultSchema = Type.Object({
  schema: Type.Literal("supacloud.application-release.v1"),
  project_ref: Type.String({ pattern: "^[a-z0-9-]{1,20}$" }),
  application_id: ApplicationIdSchema,
  environment_id: ApplicationIdSchema,
  release_id: ApplicationReleaseIdSchema,
  configuration_id: ApplicationConfigurationIdSchema,
  activation_id: ApplicationActivationIdSchema,
  expected_activation_id: nullableActivation,
  plan_sha256: ApplicationReleaseIdSchema,
  action: Type.Union([Type.Literal("activate"), Type.Literal("no-op")]),
  replayed: Type.Boolean(),
  execution_performed: Type.Boolean(),
}, closed);

export type ApplicationReleaseRequest = Static<typeof ApplicationReleaseRequestSchema>;
export type ApplicationReleaseResult = Static<typeof ApplicationReleaseResultSchema>;

export function parseApplicationReleaseResult(value: unknown): ApplicationReleaseResult {
  if (!Value.Check(ApplicationReleaseResultSchema, value)) {
    throw new Error("Invalid application release result");
  }
  return structuredClone(value);
}
