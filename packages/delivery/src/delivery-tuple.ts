import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const commit = Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" });
const isoDate = Type.String({ minLength: 20, maxLength: 40 });

export const DELIVERY_TUPLE_SCHEMA = "supacloud.fa-delivery-tuple.v1";

export const FaDeliveryTupleSchema = Type.Object({
  schema: Type.Literal(DELIVERY_TUPLE_SCHEMA),
  customer: Type.Literal("xigu-fa"),
  fa_commit: commit,
  cli: Type.Object({
    version: Type.String({ pattern: "^\\d+\\.\\d+\\.\\d+$" }),
  }, { additionalProperties: false }),
  platform_commit: commit,
  edge_runtime: Type.Object({
    version: Type.String({ minLength: 1, maxLength: 128 }),
    artifact_sha256: sha256,
  }, { additionalProperties: false }),
  compatibility_window: Type.Object({
    contract_schema: Type.String({ minLength: 1, maxLength: 128 }),
    starts_at: isoDate,
    ends_at: isoDate,
    old_client_supported: Type.Boolean(),
    partial_deployment_supported: Type.Boolean(),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export type FaDeliveryTuple = Static<typeof FaDeliveryTupleSchema>;

function validIsoDate(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function parseFaDeliveryTuple(value: unknown): FaDeliveryTuple {
  if (!Value.Check(FaDeliveryTupleSchema, value)
    || !validIsoDate(value.compatibility_window.starts_at)
    || !validIsoDate(value.compatibility_window.ends_at)
    || Date.parse(value.compatibility_window.ends_at) <= Date.parse(value.compatibility_window.starts_at)) {
    throw new Error("Invalid FA delivery tuple.");
  }
  return structuredClone(value);
}

export function isFaDeliveryTupleActive(tuple: FaDeliveryTuple, at = Date.now()): boolean {
  const start = Date.parse(tuple.compatibility_window.starts_at);
  const end = Date.parse(tuple.compatibility_window.ends_at);
  return Number.isFinite(at) && start <= at && at <= end;
}

export function formatFaDeliveryTuple(tuple: FaDeliveryTuple): string {
  return [
    `FA DELIVERY ${tuple.customer}`,
    `  fa:       ${tuple.fa_commit}`,
    `  platform: ${tuple.platform_commit}`,
    `  cli:      ${tuple.cli.version}`,
    `  edge:     ${tuple.edge_runtime.version} ${tuple.edge_runtime.artifact_sha256.slice(0, 12)}`,
    `  window:   ${tuple.compatibility_window.starts_at} -> ${tuple.compatibility_window.ends_at}`,
  ].join("\n");
}
