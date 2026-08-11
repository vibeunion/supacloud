import { expect, test } from "bun:test";
import {
  toPublicV1ProjectCreateResponse,
  toPublicV1ProjectWithDatabaseResponse,
} from "../../src/routes/project-crud";
import { publicScheduledFunctionProjectConfig } from "../../src/utils/scheduled-function-config";

function unsignedRoleKey(
  role: string,
  claims: Record<string, unknown> = { exp: 4_102_444_800 },
): string {
  const jwtSegment = (claims: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return [
    jwtSegment({ alg: "HS256", typ: "JWT" }),
    jwtSegment({ role, iss: "supabase", ...claims }),
    "s".repeat(43),
  ].join(".");
}

test("project detail serialization redacts scheduled Function payloads", () => {
  const bodySentinel = "private-project-body-sentinel";
  const headerSentinel = "private-project-header-sentinel";
  const response = toPublicV1ProjectWithDatabaseResponse({
    id: "project-id",
    ref: "proj_1",
    name: "Project",
    config: {
      unrelated: { enabled: true },
      scheduled_functions: [{
        id: "00000000-0000-4000-8000-000000000001",
        name: "Nightly",
        slug: "worker",
        cron: "0 2 * * *",
        method: "POST",
        body: { token: bodySentinel },
        headers: { "x-schedule-token": headerSentinel },
        enabled: true,
        created_at: "2026-08-11T00:00:00.000Z",
        updated_at: "2026-08-11T00:00:00.000Z",
      }],
    },
  });
  const responseText = JSON.stringify(response);
  const config = response.config as Record<string, unknown>;
  const schedules = config.scheduled_functions as Array<Record<string, unknown>>;

  expect(config.unrelated).toEqual({ enabled: true });
  expect(schedules[0]).toMatchObject({
    id: "00000000-0000-4000-8000-000000000001",
    body_empty: false,
    header_names: ["x-schedule-token"],
  });
  expect(schedules[0]).not.toHaveProperty("body");
  expect(schedules[0]).not.toHaveProperty("headers");
  expect(responseText).not.toContain(bodySentinel);
  expect(responseText).not.toContain(headerSentinel);
});

test("project detail serialization preserves redaction metadata when applied twice", () => {
  const firstPass = publicScheduledFunctionProjectConfig({
    scheduled_functions: [{
      id: "00000000-0000-4000-8000-000000000001",
      name: "Nightly",
      slug: "worker",
      cron: "0 2 * * *",
      method: "POST",
      body: { enabled: true },
      headers: { "X-Schedule-Token": "private-header-sentinel" },
      enabled: true,
      created_at: "2026-08-11T00:00:00.000Z",
      updated_at: "2026-08-11T00:00:00.000Z",
    }],
  });

  const response = toPublicV1ProjectWithDatabaseResponse({
    id: "project-id",
    ref: "proj_1",
    name: "Project",
    config: firstPass,
  });
  const config = response.config as Record<string, unknown>;
  const schedules = config.scheduled_functions as Array<Record<string, unknown>>;

  expect(schedules[0]).toMatchObject({
    body_empty: false,
    header_names: ["x-schedule-token"],
  });
});

test("project create serialization exposes only the explicitly delivered service role key", () => {
  const serviceRoleKey = unsignedRoleKey("service_role");
  const privateSentinel = "private-create-credential-sentinel";
  const source = {
    id: "project-id",
    ref: "abcdefghijklmnopqrst",
    name: "Project",
    api: { url: "https://api.example.test" },
    service_role_key: privateSentinel,
    jwt_secret: privateSentinel,
    db_password: privateSentinel,
    publishable_key: privateSentinel,
    secret_key: privateSentinel,
  };

  const ordinaryResponse = toPublicV1ProjectWithDatabaseResponse(source);
  const createResponse = toPublicV1ProjectCreateResponse(source, serviceRoleKey);

  expect(ordinaryResponse).not.toHaveProperty("credentials");
  expect(JSON.stringify(ordinaryResponse)).not.toContain(privateSentinel);
  expect(createResponse.credentials).toEqual({ service_role_key: serviceRoleKey });
  expect(JSON.stringify(createResponse)).not.toContain(privateSentinel);
  expect(createResponse).not.toHaveProperty("service_role_key");
  expect(createResponse).not.toHaveProperty("jwt_secret");
  expect(createResponse).not.toHaveProperty("db_password");
  expect(createResponse).not.toHaveProperty("publishable_key");
  expect(createResponse).not.toHaveProperty("secret_key");
});

test.each([
  ["wrong role", unsignedRoleKey("anon")],
  ["missing expiration", unsignedRoleKey("service_role", {})],
  ["expired credential", unsignedRoleKey("service_role", { exp: 1 })],
  ["nonnumeric expiration", unsignedRoleKey("service_role", { exp: "tomorrow" })],
])("project create serialization fails without reflecting %s", (_label, invalidCredential) => {
  let failure: unknown;
  try {
    toPublicV1ProjectCreateResponse({ id: "project-id", ref: "project-ref", name: "Project" }, invalidCredential);
  } catch (error: unknown) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("Project creation credentials are unavailable");
  expect((failure as Error).message).not.toContain(invalidCredential);
});
