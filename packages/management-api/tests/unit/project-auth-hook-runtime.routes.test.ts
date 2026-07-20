import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";

const requireProjectOrAdminAuth = mock(async () => undefined as undefined | {
  status: number;
  body: Record<string, unknown>;
});
const findByRef = mock(async () => ({ ref: "proj_1", config: {} }));
const detectGoTrueAuthHookStatus = mock(async (_ref: string, hookName: string) => ({
  hook_name: hookName,
  registered: true,
  verified: true,
  protocol: "standard-webhooks-v1",
  version: "gotrue-standard-webhooks-v1",
  reason_code: null,
}));
const verifyAuthHookMessage = mock(async () => ({
  verified: true,
  consumed: true,
  reason_code: null,
}));

mock.module("../../src/middleware/auth", () => ({ requireProjectOrAdminAuth }));
mock.module("../../src/repositories/project.repository", () => ({
  projectRepository: { findByRef },
}));
mock.module("../../src/services/gotrue-auth-hook-runtime.service", () => ({
  GOTRUE_HTTP_HOOK_NAMES: ["before-user-created", "custom-access-token"],
  detectGoTrueAuthHookStatus,
}));
mock.module("../../src/services/auth-hook-message.service", () => ({ verifyAuthHookMessage }));

const { projectAuthHookRuntimeRoutes } = await import("../../src/routes/project-auth-hook-runtime");
const app = new Elysia().use(projectAuthHookRuntimeRoutes);

describe("project GoTrue Auth Hook runtime routes", () => {
  beforeEach(() => {
    requireProjectOrAdminAuth.mockClear();
    requireProjectOrAdminAuth.mockResolvedValue(undefined);
    findByRef.mockClear();
    detectGoTrueAuthHookStatus.mockClear();
    verifyAuthHookMessage.mockClear();
    verifyAuthHookMessage.mockResolvedValue({ verified: true, consumed: true, reason_code: null });
  });

  test("returns registered and verified from live runtime evidence", async () => {
    const response = await app.handle(new Request(
      "http://localhost/v1/projects/proj_1/auth/hooks/before-user-created/status",
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      hook_name: "before-user-created",
      registered: true,
      verified: true,
      reason_code: null,
    });
    expect(detectGoTrueAuthHookStatus).toHaveBeenCalledWith(
      "proj_1",
      "before-user-created",
      expect.any(Object),
    );
  });

  test("delegates signature verification and replay consumption behind project authentication", async () => {
    const message = {
      webhook_id: "cf25da76-84af-4dca-8b75-b96ad5531d8a",
      webhook_timestamp: "1715686621",
      webhook_signature: "v1,signature",
      body_base64: "e30=",
    };
    const response = await app.handle(new Request(
      "http://localhost/v1/projects/proj_1/auth/hooks/custom-access-token/messages/verify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
      },
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ verified: true, consumed: true, reason_code: null });
    expect(verifyAuthHookMessage).toHaveBeenCalledWith(
      "proj_1",
      "custom-access-token",
      message,
    );
    expect(requireProjectOrAdminAuth).toHaveBeenCalledTimes(1);
  });

  test("rejects unsupported hook names before message verification", async () => {
    const response = await app.handle(new Request(
      "http://localhost/v1/projects/proj_1/auth/hooks/mfa-verification-attempt/messages/verify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          webhook_id: "cf25da76-84af-4dca-8b75-b96ad5531d8a",
          webhook_timestamp: "1715686621",
          webhook_signature: "v1,signature",
          body_base64: "e30=",
        }),
      },
    ));

    expect(response.status).toBe(404);
    expect(verifyAuthHookMessage).not.toHaveBeenCalled();
  });

  test("does not run a probe when project authentication fails", async () => {
    requireProjectOrAdminAuth.mockResolvedValueOnce({
      status: 401,
      body: { code: "UNAUTHORIZED", message: "Unauthorized" },
    });
    const response = await app.handle(new Request(
      "http://localhost/v1/projects/proj_1/auth/hooks/custom-access-token/verify",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    ));

    expect(response.status).toBe(401);
    expect(detectGoTrueAuthHookStatus).not.toHaveBeenCalled();
  });
});
