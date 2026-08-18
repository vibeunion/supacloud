import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

const findAll = mock(() => Promise.resolve([]));
const repositoryModule = await import("../../src/repositories/project.repository");
const findAllSpy = spyOn(repositoryModule.projectRepository, "findAll").mockImplementation(
  findAll as typeof repositoryModule.projectRepository.findAll,
);
const { projectEndpointSourceService } = await import(
  "../../src/services/project-endpoint-source.service"
);

describe("project endpoint routing source service", () => {
  afterAll(() => {
    findAllSpy.mockRestore();
  });

  beforeEach(() => {
    findAll.mockReset();
    findAll.mockResolvedValue([] as never);
  });

  test("returns only refs and endpoint routing config fields", async () => {
    findAll.mockResolvedValue([
      {
        id: "internal-id",
        ref: "abc123",
        name: "Project",
        config: {
          api_domain: "api.example.com",
          additional_api_domains: ["api-alt.example.com"],
          api_url_scheme: "https",
          service_role_key: "must-not-leave-private-config",
          pgrst_port: 30123,
          nested_private_config: { token: "private-token" },
        },
        db_password: "private-db-password",
        jwt_secret: "private-jwt-secret",
      },
    ] as never);

    const sources = await projectEndpointSourceService.listRoutingSources();

    expect(sources).toEqual([
      {
        ref: "abc123",
        config: {
          api_domain: "api.example.com",
          additional_api_domains: ["api-alt.example.com"],
          api_url_scheme: "https",
        },
      },
    ]);
    expect(JSON.stringify(sources)).not.toContain("private");
    expect(sources[0]).not.toHaveProperty("db_password");
    expect(sources[0]).not.toHaveProperty("jwt_secret");
    expect(sources[0]).not.toHaveProperty("name");
  });

  test("preserves the legacy string-as-custom-domain routing contract", async () => {
    findAll.mockResolvedValue([
      { ref: "legacy", config: "example.com" },
      { ref: "generated", config: { unrelated: true } },
    ] as never);

    expect(await projectEndpointSourceService.listRoutingSources()).toEqual([
      { ref: "legacy", config: { custom_domain: "example.com" } },
      { ref: "generated", config: undefined },
    ]);
  });
});
