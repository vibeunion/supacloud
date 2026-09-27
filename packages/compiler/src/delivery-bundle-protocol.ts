import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { DeliveryFilePathSchema, DeliveryOptionsSchema } from "./delivery-schema";

const closed = { additionalProperties: false } as const;
const requestSchema = Type.Object({
  parentPid: Type.Integer({ minimum: 1 }),
  name: Type.String(),
  code: Type.String(),
  project: Type.String(),
  generatedDirectory: Type.String(),
  options: DeliveryOptionsSchema,
}, closed);
const responseSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    files: Type.Array(Type.Tuple([DeliveryFilePathSchema, Type.String({ pattern: "^[A-Za-z0-9+/]*={0,2}$" })])),
    inputs: Type.Array(Type.Tuple([Type.String(), Type.String({ pattern: "^[a-f0-9]{64}$" })])),
    runtimeImports: Type.Array(Type.String()),
  }, closed),
  Type.Object({ ok: Type.Literal(false) }, closed),
]);

export type DeliveryBundleRequest = Static<typeof requestSchema>;
export type DeliveryBundleResponse = Static<typeof responseSchema>;

export function parseDeliveryBundleRequest(input: unknown): DeliveryBundleRequest {
  if (!Value.Check(requestSchema, input)) throw new Error("Invalid isolated bundle request.");
  return input;
}

export function parseDeliveryBundleResponse(input: unknown): DeliveryBundleResponse {
  if (!Value.Check(responseSchema, input)) throw new Error("Invalid isolated bundle response.");
  return input;
}
