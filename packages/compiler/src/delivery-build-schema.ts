import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DeliveryDiagnosticSchema, DeliveryFilePathSchema, DeliveryPlanSchema } from "./delivery-schema";
import { canonical, digest as hash } from "./delivery-files";

const closed = { additionalProperties: false } as const;
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const DeliveryObjectSchema = Type.Object({
  name: Type.String({ pattern: "^[a-z][a-z0-9-]{0,62}$" }),
  objectId: digest,
  inputDigest: digest,
  entrypoint: Type.Literal("bundle/index.js"),
  entryKind: Type.Literal("compiled-module-factory"),
  runtimeImports: Type.Array(Type.String()),
  files: Type.Array(Type.Object({
    path: DeliveryFilePathSchema,
    sha256: digest,
    bytes: Type.Integer({ minimum: 0 }),
  }, closed), { minItems: 1 }),
}, closed);

export const DeliveryBuildManifestSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  producer: Type.Literal("@supacloud/compiler/delivery-build-v1"),
  deploymentReady: Type.Literal(false),
  plan: DeliveryPlanSchema,
  objects: Type.Array(DeliveryObjectSchema),
  // This preserves public method/path contracts; it is not an applied gateway config.
  routes: Type.Array(Type.Object({
    method: Type.String(), path: Type.String(), target: Type.String(),
  }, closed)),
  jobs: Type.Array(Type.Object({ name: Type.String(), target: Type.String() }, closed)),
}, closed);

const resultFields = {
  diagnostics: Type.Array(DeliveryDiagnosticSchema),
  written: Type.Array(Type.String()),
  bundledTargets: Type.Array(Type.String()),
};
export const DeliveryBuildResultSchema = Type.Union([
  Type.Object({
    ...resultFields, ok: Type.Literal(true), manifest: DeliveryBuildManifestSchema,
    changedTargets: Type.Array(Type.String()),
    unchangedTargets: Type.Array(Type.String()),
    removedTargets: Type.Array(Type.String()),
  }, closed),
  Type.Object({
    ...resultFields, written: Type.Array(Type.String(), { maxItems: 0 }),
    ok: Type.Literal(false), manifest: Type.Null(),
  }, closed),
]);

export type DeliveryObject = Static<typeof DeliveryObjectSchema>;
export type DeliveryBuildManifest = Static<typeof DeliveryBuildManifestSchema>;
export type DeliveryBuildResult = Static<typeof DeliveryBuildResultSchema>;

export function parseDeliveryBuildManifest(value: unknown): DeliveryBuildManifest {
  if (!Value.Check(DeliveryBuildManifestSchema, value)) throw new Error("Invalid delivery build manifest.");
  if (new Set(value.objects.map((item) => item.name)).size !== value.objects.length) {
    throw new Error("Duplicate delivery object owner.");
  }
  if (canonical(value.objects.map((item) => item.name).sort()) !== canonical(value.plan.targets.map((item) => item.name).sort())) {
    throw new Error("Delivery objects do not match planned targets.");
  }
  for (const object of value.objects) {
    if (new Set(object.files.map((file) => file.path)).size !== object.files.length
      || !object.files.some((file) => file.path === object.entrypoint)
      || hash(canonical({ inputDigest: object.inputDigest, files: object.files })) !== object.objectId) {
      throw new Error("Invalid delivery object inventory.");
    }
  }
  const routes = value.plan.targets.flatMap((target) => target.routes.map((route) =>
    ({ method: route.method, path: route.path, target: target.name })));
  const jobs = value.plan.targets.flatMap((target) => target.jobs.map((job) => ({ name: job.name, target: target.name })));
  if (canonical(value.routes) !== canonical(routes) || canonical(value.jobs) !== canonical(jobs)) {
    throw new Error("Delivery mappings do not match planned ownership.");
  }
  return value;
}

export function parseDeliveryBuildResult(value: unknown): DeliveryBuildResult {
  if (!Value.Check(DeliveryBuildResultSchema, value)) throw new Error("Invalid delivery build result.");
  if (value.ok) parseDeliveryBuildManifest(value.manifest);
  return value;
}
