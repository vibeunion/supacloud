import { describe, expect, test } from "bun:test";
import {
  createDatabaseAccessBoundary,
  DatabaseAccessError,
} from "./access";

describe("createDatabaseAccessBoundary", () => {
  test("creates a user client from a verified request identity", async () => {
    const access = createDatabaseAccessBoundary({
      createUserClient: (identity) => ({
        subject: identity.subject,
        authorization: `Bearer ${identity.accessToken}`,
      }),
    });

    await expect(access.forUser({
      subject: "user-1",
      accessToken: "token-1",
    })).resolves.toEqual({
      subject: "user-1",
      authorization: "Bearer token-1",
    });
  });

  test("fails closed without a verified subject or access token", async () => {
    const access = createDatabaseAccessBoundary({
      createUserClient: () => ({ kind: "user" }),
    });

    await expect(access.forUser({ subject: "", accessToken: "token-1" })).rejects.toMatchObject({
      name: "DatabaseAccessError",
      code: "DATABASE_IDENTITY_REQUIRED",
    });
    await expect(access.forUser({ subject: "user-1", accessToken: "" })).rejects.toMatchObject({
      code: "DATABASE_ACCESS_TOKEN_REQUIRED",
    });
  });

  test("requires an allowlisted reason and caches the service client", async () => {
    let creates = 0;
    const access = createDatabaseAccessBoundary({
      createUserClient: () => ({ kind: "user" }),
      createServiceClient: () => ({ kind: "service", id: ++creates }),
      allowedServiceReasons: ["scheduled-maintenance"],
    });

    await expect(access.forService("")).rejects.toBeInstanceOf(DatabaseAccessError);
    await expect(access.forService("controller-request")).rejects.toMatchObject({
      code: "SERVICE_ROLE_REASON_NOT_ALLOWED",
    });
    const first = await access.forService("scheduled-maintenance");
    const second = await access.forService("scheduled-maintenance");
    expect(first).toBe(second);
    expect(creates).toBe(1);
  });

  test("does not expose service-role access when it is not configured", async () => {
    const access = createDatabaseAccessBoundary({
      createUserClient: () => ({ kind: "user" }),
      allowedServiceReasons: ["worker"],
    });

    await expect(access.forService("worker")).rejects.toMatchObject({
      code: "SERVICE_ROLE_UNAVAILABLE",
    });
  });
});
