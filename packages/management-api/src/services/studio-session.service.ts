import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config";
import {
  studioSessionRepository,
  type StudioSessionRecord,
  type StudioSessionRepository,
} from "../repositories/studio-session.repository";

const SESSION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_LOCKOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_MAX_FAILURE_BUCKETS = 10_000;
const OVERFLOW_FAILURE_BUCKET = "__overflow__";

export type StudioLoginResult =
  | { ok: true; token: string; username: string; expiresAt: Date }
  | { ok: false; reason: "invalid_credentials" | "locked"; retryAfterSeconds?: number };

export interface StudioSessionService {
  login(input: {
    username: string;
    password: string;
    clientIp: string;
    userAgent: string;
  }): Promise<StudioLoginResult>;
  verify(token: string): Promise<StudioSessionRecord | null>;
  refresh(input: {
    token: string;
    clientIp: string;
    userAgent: string;
  }): Promise<{ token: string; session: StudioSessionRecord } | null>;
  revoke(token: string): Promise<boolean>;
}

type StudioSessionServiceOptions = {
  repository?: StudioSessionRepository;
  now?: () => Date;
  expectedUsername?: string;
  expectedPassword?: string;
  randomToken?: () => string;
  maxFailures?: number;
  failureWindowMs?: number;
  lockoutMs?: number;
  maxFailureBuckets?: number;
};

type FailureBucket = {
  count: number;
  windowEndsAt: number;
  lockedUntil: number;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secureEqual(actual: string, expected: string): boolean {
  const actualHash = createHash("sha256").update(actual).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

export function createStudioSessionService(
  options: StudioSessionServiceOptions = {},
): StudioSessionService {
  const repository = options.repository ?? studioSessionRepository;
  const now = options.now ?? (() => new Date());
  const expectedUsername = options.expectedUsername ?? config.studioUsername;
  const expectedPassword = options.expectedPassword ?? config.studioPassword;
  const randomToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
  const maxFailures = Math.max(1, options.maxFailures ?? DEFAULT_MAX_FAILURES);
  const failureWindowMs = Math.max(1, options.failureWindowMs ?? DEFAULT_FAILURE_WINDOW_MS);
  const lockoutMs = Math.max(1, options.lockoutMs ?? DEFAULT_LOCKOUT_MS);
  const maxFailureBuckets = Math.max(
    2,
    options.maxFailureBuckets ?? DEFAULT_MAX_FAILURE_BUCKETS,
  );
  const usernameFailures = new Map<string, FailureBucket>();
  const ipFailures = new Map<string, FailureBucket>();

  function normalizedUsername(username: string): string {
    return username.trim().toLowerCase();
  }

  function activeLock(bucket: FailureBucket | undefined, timestamp: number): number {
    return bucket && bucket.lockedUntil > timestamp ? bucket.lockedUntil : 0;
  }

  function boundedBucketKey(
    buckets: Map<string, FailureBucket>,
    requestedKey: string,
    timestamp: number,
  ): string {
    if (buckets.has(requestedKey)) return requestedKey;
    if (buckets.size >= maxFailureBuckets) {
      for (const [key, bucket] of buckets) {
        if (bucket.windowEndsAt <= timestamp && bucket.lockedUntil <= timestamp) {
          buckets.delete(key);
        }
      }
    }
    return buckets.size < maxFailureBuckets
      ? requestedKey
      : OVERFLOW_FAILURE_BUCKET;
  }

  function recordFailure(
    buckets: Map<string, FailureBucket>,
    key: string,
    timestamp: number,
  ): number {
    const previous = buckets.get(key);
    if (previous && previous.lockedUntil > timestamp) return previous.lockedUntil;
    const bucket = !previous || previous.windowEndsAt <= timestamp
      ? { count: 0, windowEndsAt: timestamp + failureWindowMs, lockedUntil: 0 }
      : previous;
    bucket.count += 1;
    if (bucket.count >= maxFailures) bucket.lockedUntil = timestamp + lockoutMs;
    buckets.set(key, bucket);
    return bucket.lockedUntil;
  }

  return {
    async login(input) {
      const timestamp = now().getTime();
      const normalizedInputUsername = normalizedUsername(input.username);
      const normalizedExpectedUsername = normalizedUsername(expectedUsername);
      const usernameMatches = secureEqual(
        normalizedInputUsername,
        normalizedExpectedUsername,
      );
      // Only the configured account needs an individual bucket. All unknown
      // usernames share one bucket, preventing unbounded username-map growth.
      const usernameKey = usernameMatches
        ? normalizedExpectedUsername
        : "__invalid_username__";
      const ipKey = boundedBucketKey(
        ipFailures,
        input.clientIp || "unknown",
        timestamp,
      );
      const existingLock = Math.max(
        activeLock(usernameFailures.get(usernameKey), timestamp),
        activeLock(ipFailures.get(ipKey), timestamp),
      );
      if (existingLock > timestamp) {
        return {
          ok: false,
          reason: "locked",
          retryAfterSeconds: Math.ceil((existingLock - timestamp) / 1000),
        };
      }

      if (
        !usernameMatches ||
        !secureEqual(input.password, expectedPassword)
      ) {
        const lockedUntil = Math.max(
          recordFailure(usernameFailures, usernameKey, timestamp),
          recordFailure(ipFailures, ipKey, timestamp),
        );
        if (lockedUntil > timestamp) {
          return {
            ok: false,
            reason: "locked",
            retryAfterSeconds: Math.ceil((lockedUntil - timestamp) / 1000),
          };
        }
        return { ok: false, reason: "invalid_credentials" };
      }

      usernameFailures.delete(usernameKey);
      ipFailures.delete(ipKey);

      const token = randomToken();
      const expiresAt = new Date(timestamp + SESSION_TTL_MS);
      const session = await repository.create({
        username: expectedUsername,
        tokenHash: sha256(token),
        expiresAt,
        ipHash: sha256(input.clientIp),
        userAgent: input.userAgent.slice(0, 512),
      });
      return { ok: true, token, username: session.username, expiresAt: session.expiresAt };
    },

    async verify(token) {
      if (!token) return null;
      return repository.findActiveByTokenHash(sha256(token));
    },

    async refresh(input) {
      if (!input.token) return null;
      const nextToken = randomToken();
      const session = await repository.rotate({
        currentTokenHash: sha256(input.token),
        nextTokenHash: sha256(nextToken),
        expiresAt: new Date(now().getTime() + SESSION_TTL_MS),
        ipHash: sha256(input.clientIp),
        userAgent: input.userAgent.slice(0, 512),
      });
      return session ? { token: nextToken, session } : null;
    },

    async revoke(token) {
      if (!token) return false;
      return repository.revoke(sha256(token));
    },
  };
}

export const studioSessionService = createStudioSessionService();
