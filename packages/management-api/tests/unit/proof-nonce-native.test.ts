// @supacloud-test-isolate
import { expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { Type } from "@sinclair/typebox";
import { config } from "../../src/config";
import { bffProofBodyCapture } from "../../src/middleware/bff-proof-body";
import {
  consumeProofNonce, proofNonceRepository, ProofNonceUnavailableError,
} from "../../src/repositories/proof-nonce.repository";
import { buildBffProofHeaders, resolveTrustedPrincipal } from "../../src/services/bff-proof.service";
import { consumeAuthHookWebhookId } from "../../src/services/auth-hook-replay.service";
import { AppError } from "../../src/utils/errors";
import { fixtureRow } from "../helpers/fixture-rows";
import { withNativePostgres } from "../helpers/native-postgres";

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
  "native nonce transactions validate receipts, reject replay and protect real HTTP delegation",
  async () => withNativePostgres(async database => {
    await database`
      CREATE TABLE supaoauth_bff_proof_nonces (
        nonce VARCHAR(128) PRIMARY KEY,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    const expiresAt = new Date(Date.now() + 60_000);
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      consumeProofNonce("concurrent-nonce-0123456789", expiresAt, database)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter(result => !result)).toHaveLength(7);
    expect(fixtureRow(Type.Object({ nonce: Type.String(), expires_at: Type.Date() }),
      await database`SELECT nonce, expires_at FROM supaoauth_bff_proof_nonces`))
      .toEqual({ nonce: "concurrent-nonce-0123456789", expires_at: expiresAt });

    const mutableExpiry = new Date(Date.now() + 60_000);
    const expectedExpiry = new Date(mutableExpiry.getTime());
    const pending = consumeProofNonce("immutable-expiry-0123456789", mutableExpiry, database);
    mutableExpiry.setTime(0);
    expect(await pending).toBe(true);
    const storedExpiry = fixtureRow(Type.Object({ expires_at: Type.Date() }),
      await database`SELECT expires_at FROM supaoauth_bff_proof_nonces WHERE nonce = 'immutable-expiry-0123456789'`);
    expect(storedExpiry.expires_at).toEqual(expectedExpiry);

    const dbClock = fixtureRow(Type.Object({ now: Type.Date() }),
      await database`SELECT clock_timestamp() AS now`).now.getTime();
    const clock = spyOn(Date, "now").mockReturnValue(dbClock - 120_000);
    try {
      expect(await consumeProofNonce("database-expired-0123456789", new Date(dbClock - 60_000), database)).toBe(false);
    } finally {
      clock.mockRestore();
    }
    expect(await database`SELECT nonce FROM supaoauth_bff_proof_nonces WHERE nonce = 'database-expired-0123456789'`)
      .toHaveLength(0);

    await database`
      INSERT INTO supaoauth_bff_proof_nonces (nonce, expires_at)
      VALUES ('expired-fixture', NOW() - INTERVAL '1 second')
    `;
    await database.unsafe(`
      CREATE FUNCTION corrupt_nonce_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.nonce = 'corrupt-identity-0123456789' THEN
          NEW.nonce := 'wrong-identity-0123456789';
        ELSIF NEW.nonce = 'corrupt-expiry-0123456789' THEN
          NEW.expires_at := NEW.expires_at + INTERVAL '1 second';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER corrupt_nonce BEFORE INSERT ON supaoauth_bff_proof_nonces
      FOR EACH ROW EXECUTE FUNCTION corrupt_nonce_receipt();
    `);
    for (const nonce of ["corrupt-identity-0123456789", "corrupt-expiry-0123456789"]) {
      await expect(consumeProofNonce(nonce, expiresAt, database))
        .rejects.toBeInstanceOf(ProofNonceUnavailableError);
    }
    const afterRollback: unknown = await database`
      SELECT nonce FROM supaoauth_bff_proof_nonces
      WHERE nonce IN ('expired-fixture', 'wrong-identity-0123456789', 'corrupt-expiry-0123456789')
    `;
    expect(afterRollback).toEqual([{ nonce: "expired-fixture" }]);
    await database.unsafe("DROP TRIGGER corrupt_nonce ON supaoauth_bff_proof_nonces");
    expect(await consumeProofNonce("after-rollback-0123456789", expiresAt, database)).toBe(true);
    expect(await database`SELECT nonce FROM supaoauth_bff_proof_nonces WHERE nonce = 'expired-fixture'`)
      .toHaveLength(0);

    const originalMaster = config.masterToken;
    const originalSecret = config.supaoauthBffSigningSecret;
    config.masterToken = "native-proof-master-token";
    config.supaoauthBffSigningSecret = "native-proof-signing-secret-0123456789";
    const consume = spyOn(proofNonceRepository, "consume")
      .mockImplementation((nonce, expiry) => consumeProofNonce(nonce, expiry, database));
    const app = new Elysia()
      .onError(({ error }) => {
        if (error instanceof AppError) return Response.json(error.toJSON(), {
          status: error.statusCode, headers: { "cache-control": "no-store" },
        });
      })
      .use(bffProofBodyCapture)
      .post("/v1/projects/:ref/organizations", ({ request, params }) =>
        resolveTrustedPrincipal(request, params.ref));
    try {
      app.listen({ hostname: "127.0.0.1", port: 0 });
      const server = app.server;
      if (!server) throw new Error("Native proof HTTP fixture did not start");
      const url = new URL("/v1/projects/proj_1/organizations", server.url);
      const body = '{"name":"native"}';
      function headers(nonce: string, timestamp?: number): Headers {
        return new Headers({
          ...buildBffProofHeaders({
            method: "POST", pathname: url.pathname, actorId: "native-actor", actorType: "member",
            requestId: "native-request", nonce, body,
            ...(timestamp === undefined ? {} : { timestamp }),
          }),
          authorization: `Bearer ${config.masterToken}`,
          "content-type": "application/json",
        });
      }
      const signedHeaders = headers("native-http-nonce-0123456789");
      const first = await fetch(url, { method: "POST", headers: signedHeaders, body });
      expect(first.status).toBe(200);
      const principal: unknown = await first.json();
      expect(principal).toEqual({
        id: "native-actor", type: "member", requestId: "native-request", platformAdmin: false,
      });
      const replay = await fetch(url, { method: "POST", headers: signedHeaders, body });
      expect(replay.status).toBe(403);
      await replay.arrayBuffer();
      const concurrentHeaders = headers("native-http-concurrent-0123456789");
      const concurrent = await Promise.all(Array.from({ length: 8 }, async () => {
        const response = await fetch(url, { method: "POST", headers: concurrentHeaders, body });
        await response.arrayBuffer();
        return response.status;
      }));
      expect(concurrent.filter(status => status === 200)).toHaveLength(1);
      expect(concurrent.filter(status => status === 403)).toHaveLength(7);

      const futureTimestamp = Math.floor(Date.now() / 1000) + 299;
      const future = await fetch(url, {
        method: "POST", headers: headers("future-http-nonce-0123456789", futureTimestamp), body,
      });
      expect(future.status).toBe(200);
      await future.arrayBuffer();
      const expiry = fixtureRow(Type.Object({ expires_at: Type.Date() }),
        await database`SELECT expires_at FROM supaoauth_bff_proof_nonces WHERE nonce = 'future-http-nonce-0123456789'`);
      expect(expiry.expires_at.getTime()).toBe((futureTimestamp + 301) * 1000);

      consume.mockClear();
      const forged = headers("forged-http-nonce-0123456789");
      forged.set("x-supaoauth-actor-signature", `v2=${"0".repeat(64)}`);
      const denied = await fetch(url, { method: "POST", headers: forged, body });
      expect(denied.status).toBe(403);
      await denied.arrayBuffer();
      expect(consume).not.toHaveBeenCalled();

      const hookExpiry = new Date(Date.now() + 60_000);
      expect(await consumeAuthHookWebhookId("proj_1", "native-webhook-id", hookExpiry)).toBe(true);
      expect(await consumeAuthHookWebhookId("proj_1", "native-webhook-id", hookExpiry)).toBe(false);
      expect(await consumeAuthHookWebhookId("proj_2", "native-webhook-id", hookExpiry)).toBe(true);

      await database.unsafe("DROP TABLE supaoauth_bff_proof_nonces");
      consume.mockClear();
      const failure = await fetch(url, {
        method: "POST", headers: headers("failed-http-nonce-0123456789"), body,
      });
      expect(failure.status).toBe(503);
      const errorBody: unknown = await failure.json();
      expect(errorBody).toEqual({
        code: "PROOF_NONCE_UNAVAILABLE",
        message: "Delegated proof replay protection unavailable",
      });
      expect(consume).toHaveBeenCalledTimes(1);
    } finally {
      try {
        if (app.server) await app.stop(true);
      } finally {
        consume.mockRestore();
        config.masterToken = originalMaster;
        config.supaoauthBffSigningSecret = originalSecret;
      }
    }
  }),
  40_000,
);
