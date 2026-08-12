import { describe, expect, test } from "bun:test";
import {
  auditEventHash,
  redactAuditValue,
  verifyAuditChain,
} from "../../src/services/audit.service";

describe("audit redaction", () => {
  test("redacts sensitive fields recursively without mutating ordinary values", () => {
    expect(redactAuditValue({
      actor: "user-one",
      authorization: "Bearer secret",
      nested: {
        client_secret: "client-secret",
        clientSecret: "camel-secret",
        codeVerifier: "pkce-secret",
        jwt: "jwt-secret",
        session: "session-secret",
        signing_key: "signing-key-secret",
        items: [{ password: "pass" }, { safe: "visible" }],
      },
    })).toEqual({
      actor: "user-one",
      authorization: "[REDACTED]",
      nested: {
        client_secret: "[REDACTED]",
        clientSecret: "[REDACTED]",
        codeVerifier: "[REDACTED]",
        jwt: "[REDACTED]",
        session: "[REDACTED]",
        signing_key: "[REDACTED]",
        items: [{ password: "[REDACTED]" }, { safe: "visible" }],
      },
    });
  });

  test("redacts token variants and handles repeated or cyclic values", () => {
    const shared = { access_token: "access", safe: "visible" };
    const cyclic: Record<string, unknown> = { refresh_token: "refresh" };
    cyclic.self = cyclic;
    expect(redactAuditValue({ first: shared, second: shared, cyclic })).toEqual({
      first: { access_token: "[REDACTED]", safe: "visible" },
      second: { access_token: "[REDACTED]", safe: "visible" },
      cyclic: { refresh_token: "[REDACTED]", self: "[CIRCULAR]" },
    });
  });

  test("redacts bearer tokens, quoted assignments, and URL query secrets in strings", () => {
    const text = "GET https://example.test/callback?access_token=url-secret&safe=1 Authorization: Bearer bearer-secret password='quoted secret'";
    const redacted = String(redactAuditValue(text));
    expect(redacted).not.toContain("url-secret");
    expect(redacted).not.toContain("bearer-secret");
    expect(redacted).not.toContain("quoted secret");
    expect(redacted).toContain("safe=1");
    expect(redacted).toContain("[REDACTED]");
  });

  test("recomputes every event hash and validates the checkpoint count and head", () => {
    const first = chainRow("11111111-1111-1111-1111-111111111111", null, "one", 1);
    first.event_hash = auditEventHash(first);
    const second = chainRow("22222222-2222-2222-2222-222222222222", first.event_hash, "two", 2);
    second.event_hash = auditEventHash(second);
    const checkpoint = {
      project_ref: "proj_1",
      last_event_id: second.id,
      last_event_hash: second.event_hash,
      event_count: 2,
    };

    expect(verifyAuditChain([first, second], checkpoint)).toMatchObject({
      status: "verified",
      consistent: true,
      verified_event_count: 2,
    });
    expect(verifyAuditChain([{ ...first, action: "tampered" }, second], checkpoint)).toMatchObject({
      status: "mismatch",
      reason: `event hash mismatch at ${first.id}`,
    });
    expect(verifyAuditChain([first, { ...second, previous_hash: "wrong" }], checkpoint)).toMatchObject({
      status: "mismatch",
      reason: `previous hash mismatch at ${second.id}`,
    });
    expect(verifyAuditChain([first, second], { ...checkpoint, event_count: 3 })).toMatchObject({
      status: "mismatch",
      reason: "checkpoint event_count mismatch",
    });
    expect(verifyAuditChain([first, { ...second, chain_sequence: 1 }], checkpoint)).toMatchObject({
      status: "mismatch",
      reason: `chain sequence mismatch at ${second.id}`,
    });
  });

  test("uses chain sequence rather than timestamps when events share one millisecond", () => {
    const first = chainRow("11111111-1111-1111-1111-111111111111", null, "one", 1);
    first.created_at = new Date("2026-07-19T00:00:00.000Z");
    first.event_hash = auditEventHash(first);
    const second = chainRow("22222222-2222-2222-2222-222222222222", first.event_hash, "two", 2);
    second.created_at = new Date("2026-07-19T00:00:00.000Z");
    second.event_hash = auditEventHash(second);
    const checkpoint = {
      project_ref: "proj_1",
      last_event_id: second.id,
      last_event_hash: second.event_hash,
      event_count: 2,
    };
    expect(verifyAuditChain([second, first], checkpoint)).toMatchObject({
      status: "verified",
      consistent: true,
    });
  });

  test("reports unhashed historical rows as legacy instead of verified", () => {
    const legacy = chainRow("33333333-3333-3333-3333-333333333333", null, "legacy", null);
    expect(verifyAuditChain([legacy], null)).toMatchObject({
      status: "legacy_unverified",
      consistent: false,
      verified_event_count: 0,
    });
  });
});

function chainRow(id: string, previousHash: string | null, action: string, sequence: number | null) {
  return {
    id,
    project_ref: "proj_1",
    actor: "admin-one",
    actor_type: "admin",
    action,
    method: "POST",
    path: "/v1/projects/proj_1/example",
    status: 200,
    request_id: `req-${action}`,
    source: "management-api",
    metadata: { resource_type: "example", details: { safe: true } },
    previous_hash: previousHash,
    event_hash: null as string | null,
    chain_sequence: sequence,
    created_at: new Date(`2026-07-19T00:00:0${action === "one" ? 1 : 2}.000Z`),
  };
}
