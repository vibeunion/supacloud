import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config";
import { sql } from "../db";
import { getTransportAuthContextForDelegatedProof } from "../middleware/auth";
import { hasSupaOAuthDelegationHeaders } from "../utils/bff-proof-headers";
import { AuthError, ForbiddenError } from "../utils/errors";

const MAX_SKEW_SECONDS = 300;
const PROOF_NONCE_TTL_SECONDS = 300;
const ACTOR_PATTERN = /^[A-Za-z0-9@._:+/-]{1,200}$/;
const TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,49}$/;
const REQUEST_PATTERN = /^[A-Za-z0-9._:/+-]{1,200}$/;
const TIMESTAMP_PATTERN = /^\d{10,13}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const EMPTY_BODY_SHA256 = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
export type TrustedPrincipal = {
  id: string;
  type: string;
  requestId: string;
  platformAdmin: boolean;
};

type CanonicalProofInput = {
  method: string;
  pathAndSearch: string;
  timestamp: string;
  requestId: string;
  actorId: string;
  actorType: string;
  bodySha256: string;
  nonce: string;
};

type DelegatedProof = {
  principal: TrustedPrincipal;
  timestamp: string;
  signature: string;
  bodySha256: string;
  nonce: string;
};

function canonicalProof(input: CanonicalProofInput): string {
  return [
    input.method.toUpperCase(),
    input.pathAndSearch,
    input.timestamp,
    input.requestId,
    input.actorId,
    input.actorType,
    input.bodySha256,
    input.nonce,
  ].join("\n");
}

function proofDigest(canonical: string): Buffer {
  return createHmac("sha256", config.supaoauthBffSigningSecret).update(canonical).digest();
}

function validSignature(provided: string, expected: Buffer): boolean {
  if (!provided.startsWith("v2=")) return false;
  const encoded = provided.slice(3);
  if (!/^[a-f0-9]{64}$/i.test(encoded)) return false;
  const candidate = Buffer.from(encoded, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function validDigest(provided: string, expectedHex: string): boolean {
  if (!DIGEST_PATTERN.test(provided)) return false;
  const candidate = Buffer.from(provided, "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

const capturedBodyDigests = new WeakMap<Request, string>();

async function clonedRequestBodySha256(request: Request): Promise<string> {
  if (["GET", "HEAD"].includes(request.method.toUpperCase())) return EMPTY_BODY_SHA256;
  const body = await request.clone().arrayBuffer();
  return createHash("sha256").update(Buffer.from(body)).digest("hex");
}

export async function captureBffProofBody(request: Request): Promise<void> {
  const signature = request.headers.get("x-supaoauth-actor-signature")?.trim() || "";
  if (!signature.startsWith("v2=")) return;
  capturedBodyDigests.set(request, await clonedRequestBodySha256(request));
}

async function requestBodySha256(request: Request): Promise<string | null> {
  const captured = capturedBodyDigests.get(request);
  if (captured) return captured;
  if (request.bodyUsed) return null;
  return clonedRequestBodySha256(request);
}

async function consumeProofNonce(nonce: string): Promise<boolean> {
  const expiresAt = new Date(Date.now() + PROOF_NONCE_TTL_SECONDS * 1000);
  return sql.begin(async (transaction) => {
    await transaction`
      DELETE FROM supaoauth_bff_proof_nonces
      WHERE expires_at <= NOW()
    `;
    const inserted = await transaction`
      INSERT INTO supaoauth_bff_proof_nonces (nonce, expires_at)
      VALUES (${nonce}, ${expiresAt})
      ON CONFLICT (nonce) DO NOTHING
      RETURNING nonce
    `;
    return inserted.length === 1;
  });
}

function delegatedProof(request: Request): DelegatedProof | null {
  const principal = {
    id: request.headers.get("x-supaoauth-actor-id")?.trim() || "",
    type: request.headers.get("x-supaoauth-actor-type")?.trim().toLowerCase() || "",
    requestId: request.headers.get("x-request-id")?.trim() || "",
    platformAdmin: false,
  };
  const timestamp = request.headers.get("x-supaoauth-actor-timestamp")?.trim() || "";
  const signature = request.headers.get("x-supaoauth-actor-signature")?.trim() || "";
  const bodySha256 = request.headers.get("x-supaoauth-body-sha256")?.trim() || "";
  const nonce = request.headers.get("x-supaoauth-actor-nonce")?.trim() || "";
  if (
    !ACTOR_PATTERN.test(principal.id)
    || !TYPE_PATTERN.test(principal.type)
    || !REQUEST_PATTERN.test(principal.requestId)
    || !TIMESTAMP_PATTERN.test(timestamp)
    || !NONCE_PATTERN.test(nonce)
  ) return null;
  return { principal, timestamp, signature, bodySha256, nonce };
}

function freshProofTimestamp(timestamp: string): boolean {
  const numericTimestamp = Number(timestamp);
  return Number.isSafeInteger(numericTimestamp)
    && Math.abs(Date.now() / 1000 - numericTimestamp) <= MAX_SKEW_SECONDS;
}

async function delegatedPrincipal(request: Request): Promise<TrustedPrincipal | null> {
  const proof = delegatedProof(request);
  if (!proof || !freshProofTimestamp(proof.timestamp)) return null;
  const expectedBodySha256 = await requestBodySha256(request);
  if (!expectedBodySha256 || !validDigest(proof.bodySha256, expectedBodySha256)) return null;
  const url = new URL(request.url);
  const canonical = canonicalProof({
    method: request.method,
    pathAndSearch: `${url.pathname}${url.search}`,
    timestamp: proof.timestamp,
    requestId: proof.principal.requestId,
    actorId: proof.principal.id,
    actorType: proof.principal.type,
    bodySha256: proof.bodySha256,
    nonce: proof.nonce,
  });
  if (!validSignature(proof.signature, proofDigest(canonical))) return null;
  return await consumeProofNonce(proof.nonce) ? proof.principal : null;
}

const verifiedProjectRequests = new WeakMap<Request, { ref: string; principal: TrustedPrincipal }>();

export async function resolveTrustedPrincipal(request: Request, ref: string): Promise<TrustedPrincipal> {
  const cached = verifiedProjectRequests.get(request);
  if (cached) {
    if (cached.ref !== ref) throw new ForbiddenError("Project token scope mismatch");
    return cached.principal;
  }
  const auth = await getTransportAuthContextForDelegatedProof(request);
  if ("status" in auth) {
    if (auth.status === 401) throw new AuthError("Verified management principal required");
    throw new ForbiddenError("Verified management principal required");
  }
  if (auth.role === "project" && auth.ref !== ref) {
    throw new ForbiddenError("Project token scope mismatch");
  }
  if (auth.role === "project" || hasSupaOAuthDelegationHeaders(request)) {
    const delegated = await delegatedPrincipal(request);
    if (!delegated) {
      throw new ForbiddenError("A valid SupaOAuth BFF proof is required for actor delegation");
    }
    verifiedProjectRequests.set(request, { ref, principal: delegated });
    return delegated;
  }
  return {
    id: auth.principalId,
    type: auth.role,
    requestId: request.headers.get("x-request-id")?.trim() || crypto.randomUUID(),
    platformAdmin: true,
  };
}

export function buildBffProofHeaders(input: {
  method: string;
  pathname: string;
  search?: string;
  actorId: string;
  actorType: string;
  requestId: string;
  timestamp?: number;
  nonce?: string;
  body?: BodyInit | null;
}): Record<string, string> {
  const timestamp = String(input.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = input.nonce || crypto.randomUUID();
  const bodySha256 = bodySha256ForProof(input.body, input.method);
  const canonical = canonicalProof({
    method: input.method,
    pathAndSearch: `${input.pathname}${input.search || ""}`,
    timestamp,
    requestId: input.requestId,
    actorId: input.actorId,
    actorType: input.actorType,
    bodySha256,
    nonce,
  });
  return {
    "x-supaoauth-actor-id": input.actorId,
    "x-supaoauth-actor-type": input.actorType,
    "x-supaoauth-actor-timestamp": timestamp,
    "x-supaoauth-body-sha256": bodySha256,
    "x-supaoauth-actor-nonce": nonce,
    "x-supaoauth-actor-signature": `v2=${createHmac("sha256", config.supaoauthBffSigningSecret).update(canonical).digest("hex")}`,
    "x-request-id": input.requestId,
  };
}

function bodySha256ForProof(body: BodyInit | null | undefined, method: string): string {
  if (["GET", "HEAD"].includes(method.toUpperCase()) || body == null) return EMPTY_BODY_SHA256;
  if (typeof body === "string") return createHash("sha256").update(Buffer.from(body)).digest("hex");
  if (body instanceof ArrayBuffer) return createHash("sha256").update(Buffer.from(body)).digest("hex");
  if (ArrayBuffer.isView(body)) {
    return createHash("sha256")
      .update(Buffer.from(body.buffer, body.byteOffset, body.byteLength))
      .digest("hex");
  }
  if (body instanceof URLSearchParams) {
    return createHash("sha256").update(Buffer.from(body.toString())).digest("hex");
  }
  throw new TypeError("SupaCloud BFF proof requires a replayable non-stream body");
}
