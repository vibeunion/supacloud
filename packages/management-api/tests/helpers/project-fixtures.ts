import type { ProjectDetailResponse } from "../../src/services/project.service";

export function projectDetailFixture(
  overrides: Partial<ProjectDetailResponse> = {},
): ProjectDetailResponse {
  return {
    id: "fixture", ref: "proj_1", name: "Fixture", status: "active",
    region: "local", organization_id: "fixture",
    created_at: new Date(0), updated_at: new Date(0),
    database: { host: "127.0.0.1", name: "fixture", user: "fixture" },
    api: { url: "https://api.example.test" },
    studio: { url: "https://studio.example.test" },
    config: {}, ...overrides,
  };
}
