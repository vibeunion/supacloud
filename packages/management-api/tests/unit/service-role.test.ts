import { describe, expect, test } from "bun:test";
import { resolveProjectServiceRoleKey } from "../../src/utils/service-role";

describe("service-role utils", () => {
  test("prefers the stored canonical service_role_key", async () => {
    await expect(
      resolveProjectServiceRoleKey({
        service_role_key: "stored-key",
        jwt_secret: "jwt-secret",
      }),
    ).resolves.toBe("stored-key");
  });

  test("falls back to generating a key from jwt_secret when needed", async () => {
    const key = await resolveProjectServiceRoleKey({
      jwt_secret: "fallback-jwt-secret",
    });

    expect(typeof key).toBe("string");
    expect(key?.split(".")).toHaveLength(3);
  });

  test("returns null when no project key material exists", async () => {
    await expect(resolveProjectServiceRoleKey({})).resolves.toBeNull();
  });
});
