import { expect, test } from "bun:test";
import { toPublicV1ProjectWithDatabaseResponse } from "../../src/routes/project-crud";
import { publicScheduledFunctionProjectConfig } from "../../src/utils/scheduled-function-config";

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
