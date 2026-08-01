import { afterEach, describe, expect, test } from "bun:test";
import { authProvider } from "./auth";

const originalFetch = globalThis.fetch;

describe("admin auth provider", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("does not redirect when backend logout fails", async () => {
    globalThis.fetch = async () => Response.json(
      { error: "Unable to revoke session" },
      { status: 502 },
    );

    const logout = await authProvider.logout();

    expect(logout.success).toBeFalse();
    expect(logout.redirectTo).toBeUndefined();
    expect(logout.error?.message).toBe("Unable to revoke session");
  });

  test("redirects after backend logout succeeds", async () => {
    globalThis.fetch = async () => Response.json({ success: true });

    await expect(authProvider.logout()).resolves.toEqual({
      success: true,
      redirectTo: "/login",
    });
  });
});
