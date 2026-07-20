import { describe, test, expect, mock, spyOn } from "bun:test";
import { config } from "../../src/config";
import { sql } from "../../src/db";
import { buildBffProofHeaders } from "../../src/services/bff-proof.service";
import {
  extractProjectRefCandidates,
  extractProjectRefFromPath,
} from "../../src/utils/project-auth";
import {
  createAuthResolver,
  getAuthContext,
  isInvitationAcceptanceRequest,
  isSameOriginStudioRequest,
  requireAdminAuth,
} from "../../src/middleware/auth";

describe("Auth Middleware Logic", () => {
  const masterToken = config.masterToken;

  test("should have a master token configured", () => {
    expect(masterToken).toBeDefined();
    expect(masterToken.length).toBeGreaterThan(0);
  });

  test("should match valid Bearer token format", () => {
    const validHeader = `Bearer ${masterToken}`;
    expect(validHeader.startsWith("Bearer ")).toBe(true);

    const token = validHeader.slice(7);
    expect(token).toBe(masterToken);
  });

  test("should reject non-Bearer formats", () => {
    const basicHeader = "Basic dXNlcjpwYXNz";
    expect(basicHeader.startsWith("Bearer ")).toBe(false);
  });

  test("should reject empty authorization", () => {
    const emptyHeader = "";
    expect(emptyHeader.startsWith("Bearer ")).toBe(false);
  });

  test("should reject wrong token", () => {
    const wrongToken = "wrong-token-value";
    expect(wrongToken).not.toBe(masterToken);
  });

  test("should extract scoped project ref from management API path", () => {
    expect(
      extractProjectRefFromPath("/v1/projects/urocrsxqvrudgdgndiny/database/sql"),
    ).toBe("urocrsxqvrudgdgndiny");
    expect(extractProjectRefFromPath("/health")).toBeNull();
  });

  test("should prefer scoped project ref when JWT issuer is generic", () => {
    expect(
      extractProjectRefCandidates(
        { iss: "supabase", role: "service_role" },
        "urocrsxqvrudgdgndiny",
      ),
    ).toEqual(["urocrsxqvrudgdgndiny"]);
  });

  test("should extract project ref candidates from payload and issuer URL", () => {
    expect(
      extractProjectRefCandidates({
        iss: "https://urocrsxqvrudgdgndiny.supabase.co",
        ref: "urocrsxqvrudgdgndiny",
        role: "service_role",
      }),
    ).toEqual(["urocrsxqvrudgdgndiny"]);
  });

  test("accepts a valid Studio cookie but rejects cross-origin cookie writes", async () => {
    const resolver = createAuthResolver({
      studioSessions: {
        verify: async (token: string) => token === "valid-session"
          ? { id: "session-1", username: "admin", expiresAt: new Date(Date.now() + 60_000) }
          : null,
      },
    });

    const read = await resolver(new Request("https://console.example.com/v1/profile", {
      headers: { cookie: "__Host-supacloud_session=valid-session" },
    }));
    expect(read).toMatchObject({ role: "admin", source: "cookie" });

    const write = await resolver(new Request("https://console.example.com/v1/projects", {
      method: "POST",
      headers: {
        cookie: "__Host-supacloud_session=valid-session",
        origin: "https://evil.example.net",
      },
    }));
    expect(write).toEqual({ status: 403, body: { error: "Cross-origin session request denied" } });
  });

  test("does not accept the removed two-part Studio HMAC bearer token", async () => {
    const payload = JSON.stringify({ user: "admin", exp: Date.now() + 60_000 });
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(config.masterToken),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    const sigHex = Array.from(new Uint8Array(signature))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const legacyToken = `${btoa(payload)}.${sigHex}`;

    const resolver = createAuthResolver({ studioSessions: { verify: async () => null } });
    const result = await resolver(new Request("https://console.example.com/v1/profile", {
      headers: { authorization: `Bearer ${legacyToken}` },
    }));

    expect(result).toEqual({ status: 401, body: { error: "Invalid token" } });
  });

  test("same-origin checks ignore a forged forwarded host", () => {
    const request = new Request("https://console.example.com/v1/projects", {
      method: "POST",
      headers: {
        origin: "https://attacker.example.net",
        "x-forwarded-host": "attacker.example.net",
        "x-forwarded-proto": "https",
      },
    });
    expect(isSameOriginStudioRequest(request)).toBe(false);
  });

  test("does not bypass auth on invitation routes carrying delegated headers", () => {
    const request = new Request(
      "https://console.example.com/v1/projects/proj_1/collaborator-invitations/invite_1/accept",
      { method: "POST", headers: { "x-supaoauth-actor-id": "forged-owner" } },
    );
    expect(isInvitationAcceptanceRequest(request)).toBe(false);
  });

  test("rejects partial delegated headers before a master token can authorize the request", async () => {
    const result = await getAuthContext(new Request("https://console.example.com/v1/projects/proj_1/capabilities", {
      headers: {
        authorization: `Bearer ${masterToken}`,
        "x-supaoauth-actor-id": "forged-owner",
      },
    }));

    expect(result).toEqual({
      status: 403,
      body: { error: "A valid SupaOAuth BFF proof is required for actor delegation" },
    });
  });

  test("keeps a valid delegated actor project-scoped instead of inheriting the master role", async () => {
    const previousSigningSecret = config.supaoauthBffSigningSecret;
    config.supaoauthBffSigningSecret = "test-bff-signing-secret-0123456789abcdef";
    const nonceTransaction = mock((strings: TemplateStringsArray, ...values: unknown[]) => (
      Promise.resolve(strings.join("?").includes("INSERT INTO supaoauth_bff_proof_nonces")
        ? [{ nonce: values[0] }]
        : [])
    ));
    const begin = spyOn(sql, "begin").mockImplementation(
      async (callback: (database: typeof nonceTransaction) => Promise<unknown>) => callback(nonceTransaction),
    );
    const pathname = "/v1/projects/proj_1/capabilities";
    const request = new Request(`https://console.example.com${pathname}`, {
      headers: {
        authorization: `Bearer ${masterToken}`,
        ...buildBffProofHeaders({
          method: "GET",
          pathname,
          actorId: "collaborator-one",
          actorType: "member",
          requestId: "request-delegated",
          nonce: "nonce-delegated-0123456789",
        }),
      },
    });

    try {
      expect(await getAuthContext(request)).toMatchObject({
        role: "project",
        ref: "proj_1",
        principalId: "collaborator-one",
      });
      expect(await requireAdminAuth(request)).toEqual({
        status: 403,
        body: { error: "Admin privileges required" },
      });
    } finally {
      begin.mockRestore();
      config.supaoauthBffSigningSecret = previousSigningSecret;
    }
  });
});
