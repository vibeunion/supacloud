// @supacloud-test-isolate
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";

const listExtensions = mock(async () => []);
const enableExtension = mock(async (_ref: string, name: string) => ({ name, is_installed: true }));
const disableExtension = mock(async (_ref: string, name: string) => ({ name, is_installed: false }));
const requireProjectOrAdminAuth = mock(async () => undefined as undefined | {
  status: number;
  body: { error: string };
});

mock.module("../../src/services/extension.service", () => ({
  extensionService: {
    listExtensions,
    enableExtension,
    disableExtension,
  },
}));
mock.module("../../src/middleware/auth", () => ({
  requireAdminAuth: mock(async () => undefined),
  requireProjectOrAdminAuth,
}));
mock.module("../../src/utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
  },
}));

const { extensionRoutes, databaseExtensionRoutes } = await import(
  new URL("../../src/routes/extensions.ts?extensions-routes-test", import.meta.url).href,
);
const app = new Elysia().use(extensionRoutes).use(databaseExtensionRoutes);

function request(path: string, init?: RequestInit) {
  return app.handle(new Request(`http://localhost/v1/projects/proj_1${path}`, init));
}

describe("extension routes", () => {
  beforeEach(() => {
    listExtensions.mockClear();
    enableExtension.mockClear();
    disableExtension.mockClear();
    requireProjectOrAdminAuth.mockReset();
    requireProjectOrAdminAuth.mockResolvedValue(undefined);
  });

  test("rejects delegated requests without the required project capability", async () => {
    requireProjectOrAdminAuth.mockResolvedValueOnce({
      status: 403,
      body: { error: "operations.manage required" },
    });

    const response = await request("/extensions/enable", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ extension: "postgis" }),
    });

    expect(response.status).toBe(403);
    expect(enableExtension).not.toHaveBeenCalled();
  });

  test("checks project capability on both extension route families", async () => {
    const first = await request("/extensions");
    const second = await request("/database/extensions");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(requireProjectOrAdminAuth).toHaveBeenCalledTimes(2);
    expect(requireProjectOrAdminAuth.mock.calls.map((call) => call[1])).toEqual(["proj_1", "proj_1"]);
    expect(listExtensions).toHaveBeenCalledTimes(2);
  });
});
