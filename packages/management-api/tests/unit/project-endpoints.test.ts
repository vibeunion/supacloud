import { describe, expect, test } from "bun:test";
import { projectEndpointProjection } from "../../src/routes/project-endpoints";

describe("project endpoint projection", () => {
  test("projects explicit API, Auth, Studio, and API alias domains", () => {
    const projection = projectEndpointProjection({
      ref: "abc123",
      name: "Example",
      status: "active",
      config: {
        api_domain: "api.example.com",
        auth_domain: "auth.example.com",
        studio_domain: "studio.example.com",
        additional_api_domains: ["api-alt.example.com", "api-alt.example.com"],
      },
    });

    expect(projection).toEqual({
      schema: "supacloud.project-endpoints.v1",
      project_ref: "abc123",
      project_name: "Example",
      project_status: "ACTIVE_HEALTHY",
      endpoints: {
        api: {
          origin: "https://api.example.com",
          host: "api.example.com",
          aliases: expect.arrayContaining(["api-alt.example.com"]),
          source: "explicit",
          status: "configured",
          verification: "not_checked",
        },
        auth: {
          origin: "https://auth.example.com",
          host: "auth.example.com",
          aliases: [],
          source: "explicit",
          status: "configured",
          verification: "not_checked",
        },
        studio: {
          origin: "https://studio.example.com",
          host: "studio.example.com",
          aliases: [],
          source: "explicit",
          status: "configured",
          verification: "not_checked",
        },
      },
    });
  });

  test("marks base-domain projections as derived without claiming external verification", () => {
    const projection = projectEndpointProjection({
      ref: "abc123",
      name: "Example",
      status: "creating",
      config: { custom_domain: "example.com" },
    });

    expect(projection.project_status).toBe("COMING_UP");
    expect(projection.endpoints.api).toMatchObject({
      origin: "https://api.example.com",
      source: "derived",
      status: "pending",
      verification: "not_checked",
    });
    expect(projection.endpoints.auth).toMatchObject({
      origin: "https://api.example.com",
      source: "derived",
      status: "pending",
      verification: "not_checked",
    });
    expect(projection.endpoints.studio).toMatchObject({
      origin: "https://studio.example.com",
      source: "derived",
      status: "pending",
      verification: "not_checked",
    });
  });

  test("marks paused projects inactive", () => {
    const projection = projectEndpointProjection({
      ref: "abc123",
      name: "Example",
      status: "paused",
      config: { api_domain: "api.example.com" },
    });

    expect(projection.project_status).toBe("INACTIVE");
    expect(Object.values(projection.endpoints).every((endpoint) => endpoint.status === "inactive")).toBe(true);
  });
});
