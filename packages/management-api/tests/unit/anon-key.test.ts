import { describe, expect, test } from "bun:test";
import { jwtService } from "../../src/services/jwt.service";
import {
  isStoredAnonKeyAligned,
  resolveAlignedAnonKey,
  resolveStoredAnonKey,
} from "../../src/utils/anon-key";

describe("anon-key utils", () => {
  test("resolves encrypted or plaintext stored credentials", () => {
    expect(resolveStoredAnonKey({ anon_key: "stored.anon.key" })).toBe("stored.anon.key");
    expect(resolveStoredAnonKey({ anon_key: "", anon_key_encrypted: "encrypted.anon.key" })).toBe("encrypted.anon.key");
    expect(resolveStoredAnonKey({})).toBeNull();
  });

  test("detects a legacy anon key signed by a different project secret", async () => {
    const key = await jwtService.generateAnonKey("old-secret-with-at-least-32-characters");

    await expect(isStoredAnonKeyAligned({
      anon_key: key,
      jwt_secret: "old-secret-with-at-least-32-characters",
    })).resolves.toBe(true);
    await expect(isStoredAnonKeyAligned({
      anon_key: key,
      jwt_secret: "current-secret-with-at-least-32-characters",
    })).resolves.toBe(false);
  });

  test("derives an aligned replacement for a stale legacy key", async () => {
    const staleKey = await jwtService.generateAnonKey("old-secret-with-at-least-32-characters");
    const currentSecret = "current-secret-with-at-least-32-characters";
    const replacement = await resolveAlignedAnonKey({
      anon_key: staleKey,
      jwt_secret: currentSecret,
    });

    expect(replacement).toBeTruthy();
    expect(replacement).not.toBe(staleKey);
    await expect(isStoredAnonKeyAligned({
      anon_key: replacement,
      jwt_secret: currentSecret,
    })).resolves.toBe(true);
  });

  test("preserves opaque and non-HS256 compatibility credentials", async () => {
    await expect(isStoredAnonKeyAligned({
      anon_key: "anon.header.signature",
      jwt_secret: "current-secret-with-at-least-32-characters",
    })).resolves.toBe(true);
    await expect(resolveAlignedAnonKey({
      anon_key: "anon.header.signature",
      jwt_secret: "current-secret-with-at-least-32-characters",
    })).resolves.toBe("anon.header.signature");
  });
});
