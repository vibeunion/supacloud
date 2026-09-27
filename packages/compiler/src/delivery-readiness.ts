import { APPLICATION_RUNTIME_PROBE_PATH } from "@supacloud/delivery";

export { APPLICATION_RUNTIME_PROBE_PATH };

/** Inline the small host contract so detached apps need no extra runtime package. */
export function renderDeliveryRuntimeIdentity(): string {
  return `
function deliveryRuntimeIdentity(kind: "http" | "worker") {
  const env = deliveryProcess.env;
  if (env.SUPACLOUD_ACTIVATION_ID === undefined) return null;
  const identity = {
    schema: "supacloud.application-runtime.v1",
    project_ref: env.SUPACLOUD_PROJECT_REF,
    application_id: env.SUPACLOUD_APPLICATION_ID,
    environment_id: env.SUPACLOUD_ENVIRONMENT_ID,
    release_id: env.SUPACLOUD_RELEASE_ID,
    activation_id: env.SUPACLOUD_ACTIVATION_ID,
    target: env.SUPACLOUD_TARGET,
    object_id: env.SUPACLOUD_OBJECT_ID,
    kind, pid: deliveryProcess.pid,
  };
  const matches = (value: string | undefined, pattern: RegExp) => typeof value === "string" && pattern.test(value);
  if (!matches(identity.project_ref, /^[a-z0-9-]{1,20}$/)
    || !matches(identity.application_id, /^[A-Za-z0-9_-]{1,64}$/)
    || !matches(identity.environment_id, /^[A-Za-z0-9_-]{1,64}$/)
    || !matches(identity.release_id, /^[a-f0-9]{64}$/)
    || !matches(identity.activation_id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
    || !matches(identity.target, /^[a-z][a-z0-9-]{0,62}$/)
    || !matches(identity.object_id, /^[a-f0-9]{64}$/)) throw new Error("Invalid managed runtime identity.");
  return identity;
}
`;
}
