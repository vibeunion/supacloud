// @supacloud-test-isolate — exercises CLI project listing against mixed payload shapes.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

const promptsMock = {
  intro: mock(() => undefined),
  outro: mock(() => undefined),
  cancel: mock(() => undefined),
  isCancel: mock(() => false),
  spinner: mock(() => ({
    start: mock(() => undefined),
    stop: mock(() => undefined),
  })),
  text: mock(async () => ""),
  confirm: mock(async () => false),
  log: {
    success: mock(() => undefined),
    info: mock(() => undefined),
    error: mock(() => undefined),
  },
};

mock.module("@clack/prompts", () => promptsMock);
mock.module("../../src/config", () => ({
  config: {
    supacloudApiUrl: "https://supacloud.example",
    masterToken: "test-master-token",
  },
}));

const originalFetch = globalThis.fetch;
const originalExit = process.exit;
const logSpy = spyOn(console, "log").mockImplementation(() => undefined as never);
const exitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
  throw new Error(`process.exit:${code ?? 0}`);
}) as unknown as typeof process.exit;

const { handleProjectGet, handleProjectList } = await import(
  new URL("../../src/cli/project.ts?project-cli-regression", import.meta.url).href
);

function resetMocks() {
  logSpy.mockClear();
  exitSpy.mockClear();
  mock.clearAllMocks();
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.exit = originalExit;
  resetMocks();
});

beforeEach(() => {
  resetMocks();
});

describe("project CLI URL rendering", () => {
  test("renders nested and flat project URLs without crashing in project list", async () => {
    const projects = [
      {
        name: "Legacy project",
        ref: "legacy",
        status: "active",
        api_url: "https://legacy-api.example",
        studioUrl: "https://legacy-studio.example",
      },
      {
        name: "Nested project",
        ref: "nested",
        status: "paused",
        api: { url: "https://nested-api.example" },
        studio: { url: "https://nested-studio.example" },
      },
    ];

    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toBe("https://supacloud.example/v1/projects");
      return Response.json(projects);
    }) as typeof fetch;

    await handleProjectList();

    const rendered = logSpy.mock.calls.map((call) => call.map((value) => String(value)).join(" "));
    expect(rendered.join("\n")).toContain("Legacy project (legacy)");
    expect(rendered.join("\n")).toContain("API: https://legacy-api.example");
    expect(rendered.join("\n")).toContain("Studio: https://legacy-studio.example");
    expect(rendered.join("\n")).toContain("Nested project (nested)");
    expect(rendered.join("\n")).toContain("API: https://nested-api.example");
    expect(rendered.join("\n")).toContain("Studio: https://nested-studio.example");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test("renders flat project URLs in project get without crashing", async () => {
    const project = {
      name: "Legacy project",
      ref: "legacy",
      status: "active",
      region: "local",
      created_at: "2026-09-02T00:00:00.000Z",
      apiUrl: "https://legacy-api.example",
      studio_url: "https://legacy-studio.example",
      database: { name: "supa_legacy" },
    };

    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toBe("https://supacloud.example/v1/projects/legacy");
      return Response.json(project);
    }) as typeof fetch;

    await handleProjectGet("legacy");

    const rendered = logSpy.mock.calls.map((call) => call.map((value) => String(value)).join(" "));
    expect(rendered.join("\n")).toContain("API URL: https://legacy-api.example");
    expect(rendered.join("\n")).toContain("Studio URL: https://legacy-studio.example");
    expect(rendered.join("\n")).toContain("Database: supa_legacy");
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
