import { expect, test } from "bun:test";
import { RealtimeBunService } from "../../src/services/realtime-bun.service";
import type { ProjectJwtVerification } from "../../src/utils/project-jwt";

const subscriptions = [{ event: "*", schema: "public", table: "orders" }] as const;
const user: ProjectJwtVerification = {
  payload: { role: "authenticated", sub: "fixture" },
  protectedHeader: { alg: "HS256" }, isServiceRole: false,
};

test("missing or rejected JWTs never resolve a database or create triggers", async () => {
  let calls = 0;
  const service = new RealtimeBunService({
    resolveDatabase: async () => { calls++; throw new Error("Must not connect"); },
    verifyJwt: async () => null,
  });
  expect(await service.subscribeTenant("fixture", [...subscriptions])).toBeNull();
  expect(await service.subscribeTenant("fixture", [...subscriptions], "invalid")).toBeNull();
  expect(calls).toBe(0);
});

test("a signed service role without stored-key provenance cannot bypass RLS", async () => {
  let calls = 0;
  const service = new RealtimeBunService({
    resolveDatabase: async () => { calls++; throw new Error("Must not connect"); },
    verifyJwt: async () => ({ ...user, payload: { role: "service_role", __allow_service_role: true } }),
  });
  expect(await service.subscribeTenant("fixture", [...subscriptions], "unprivileged")).toBeNull();
  expect(calls).toBe(0);
});

test("cancelling a tenant during token verification prevents late registration", async () => {
  const pending = Promise.withResolvers<ProjectJwtVerification | null>();
  let calls = 0;
  const service = new RealtimeBunService({
    resolveDatabase: async () => { calls++; throw new Error("Must not connect"); },
    verifyJwt: () => pending.promise,
  });
  const registration = service.subscribeTenant("fixture", [...subscriptions], "valid");
  await service.unsubscribeTenant("fixture");
  pending.resolve(user);
  expect(await registration).toBeNull();
  expect(calls).toBe(0);
});

test("failed database startup rolls back registration and allows a fresh attempt", async () => {
  let calls = 0;
  const service = new RealtimeBunService({
    resolveDatabase: async () => { calls++; throw new Error("Fixture unavailable"); },
    verifyJwt: async () => user,
  });
  expect(await service.subscribeTenant("fixture", [...subscriptions], "valid")).toBeNull();
  expect(await service.subscribeTenant("fixture", [...subscriptions], "valid")).toBeNull();
  expect(calls).toBe(2);
  await service.unsubscribeTenant("fixture");
});

test("unsupported native configurations are rejected before authentication or database access", async () => {
  let calls = 0;
  const service = new RealtimeBunService({
    resolveDatabase: async () => { calls++; throw new Error("Must not connect"); },
    verifyJwt: async () => { calls++; return user; },
  });
  for (const subscription of [
    { event: "*", schema: "public" },
    { event: "*", schema: "public", table: "*" },
    { event: "*", schema: "public", table: "bad;sql" },
    { event: "*", schema: "public", table: "orders", filter: "id=not.eq.1" },
  ] as const) expect(await service.subscribeTenant("fixture", [subscription], "valid")).toBeNull();
  expect(calls).toBe(0);
});

test("per-channel abort during JWT verification prevents database startup", async () => {
  const pending = Promise.withResolvers<ProjectJwtVerification | null>();
  const controller = new AbortController();
  let calls = 0;
  const service = new RealtimeBunService({
    resolveDatabase: async () => { calls++; throw new Error("Must not connect"); },
    verifyJwt: () => pending.promise,
  });
  const registration = service.subscribeTenant("fixture", [...subscriptions], "valid", { signal: controller.signal });
  controller.abort();
  pending.resolve(user);
  expect(await registration).toBeNull();
  expect(calls).toBe(0);
});
