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

  test("returns only refs and private routing configs required by projection", async () => {
    findAll.mockResolvedValue([
      {
        id: "internal-id",
        ref: "abc123",
        name: "Project",
        config: {
          api_domain: "api.example.com",
          service_role_key: "must-not-be-copied-from-config-fixture",
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
          service_role_key: "must-not-be-copied-from-config-fixture",
        },
      },
    ]);
    expect(sources[0]).not.toHaveProperty("db_password");
    expect(sources[0]).not.toHaveProperty("jwt_secret");
    expect(sources[0]).not.toHaveProperty("name");
  });
});
