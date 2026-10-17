import { expect, test } from "bun:test";
import {
  formatFaDeliveryTuple,
  isFaDeliveryTupleActive,
  parseFaDeliveryTuple,
  type FaDeliveryTuple,
} from "./delivery-tuple";

const tuple: FaDeliveryTuple = {
  schema: "supacloud.fa-delivery-tuple.v1",
  customer: "xigu-fa",
  fa_commit: "a".repeat(40),
  cli: { version: "0.96.1" },
  platform_commit: "b".repeat(40),
  edge_runtime: { version: "0.16.5", artifact_sha256: "c".repeat(64) },
  compatibility_window: {
    contract_schema: "fa-command-contract.v3",
    starts_at: "2026-10-14T00:00:00.000Z",
    ends_at: "2026-11-14T00:00:00.000Z",
    old_client_supported: true,
    partial_deployment_supported: true,
  },
};

test("parses the complete FA delivery tuple and checks the compatibility window", () => {
  expect(parseFaDeliveryTuple(tuple)).toEqual(tuple);
  expect(isFaDeliveryTupleActive(tuple, Date.parse("2026-10-20T00:00:00.000Z"))).toBe(true);
  expect(formatFaDeliveryTuple(tuple)).toContain("cli:      0.96.1");
});

test("rejects a reversed or incomplete compatibility window", () => {
  expect(() => parseFaDeliveryTuple({
    ...tuple,
    compatibility_window: { ...tuple.compatibility_window, ends_at: tuple.compatibility_window.starts_at },
  })).toThrow("Invalid FA delivery tuple.");
  expect(() => parseFaDeliveryTuple({
    ...tuple,
    edge_runtime: { ...tuple.edge_runtime, artifact_sha256: "not-a-digest" },
  })).toThrow("Invalid FA delivery tuple.");
});
