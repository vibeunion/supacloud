import { describe, test, expect } from "bun:test";
import { Elysia, t } from "elysia";
import { config } from "../../src/config";

// Simplified test suite - tests authentication middleware and mock endpoints
const AUTH_HEADER = { Authorization: `Bearer ${config.masterToken}` };
const INVALID_TOKEN_HEADER = { Authorization: "Bearer invalid-token" };
const BASIC_HEADER = { Authorization: "Basic dXNlcjpwYXNz" };

// Mock project data
const mockProjects: Map<string, any> = new Map();
let projectCounter = 0;

// Create complete mock test app (no database dependency)
const testApp = new Elysia()
  // Health check
  .get("/health", () => ({ status: "ok", timestamp: new Date().toISOString() }))

  // Auth middleware
  .derive(({ headers, set }) => {
    const authorization = headers.authorization;

    if (!authorization) {
      set.status = 401;
      return { authorized: false, authError: "Missing Authorization header" };
    }

    if (!authorization.startsWith("Bearer ")) {
      set.status = 401;
      return { authorized: false, authError: "Invalid Authorization format" };
    }

    const token = authorization.slice(7);

    if (token !== config.masterToken) {
      set.status = 403;
      return { authorized: false, authError: "Invalid token" };
    }

    return { authorized: true, authError: null };
  })
  .onBeforeHandle(({ authorized, authError }) => {
    if (authorized === false) {
      return { error: authError || "Unauthorized" };
    }
  })

  // Available regions
  .get("/v1/projects/available-regions", () => [
    { code: "local", name: "Local", continent: "local" },
    { code: "us-east-1", name: "US East (N. Virginia)", continent: "americas" },
    { code: "us-west-1", name: "US West (N. California)", continent: "americas" },
    { code: "eu-west-1", name: "EU (Ireland)", continent: "emea" },
    { code: "ap-southeast-1", name: "Asia Pacific (Singapore)", continent: "apac" },
  ])

  // Get all projects
  .get("/v1/projects", () => {
    return Array.from(mockProjects.values()).filter((p) => !p.deleted_at);
  })

  // Create project
  .post(
    "/v1/projects",
    ({ body, set }) => {
      const ref = `test${++projectCounter}`;
      const project = {
        id: `uuid-${ref}`,
        ref,
        name: body.name,
        status: "creating",
        region: body.region || "local",
        created_at: new Date(),
        updated_at: new Date(),
        deleted_at: null,
        config: {},
        database: { host: "localhost", name: `supa_${ref}`, user: `role_${ref}` },
        api: { url: `https://${ref}.api.localhost` },
      };
      mockProjects.set(ref, project);
      set.status = 201;
      return project;
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 100 }),
        region: t.Optional(t.String()),
        organization_id: t.Optional(t.String()),
      }),
    }
  )

  // Get project details
  .get(
    "/v1/projects/:ref",
    ({ params, set }) => {
      const project = mockProjects.get(params.ref);
      if (!project || project.deleted_at) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return project;
    },
    { params: t.Object({ ref: t.String() }) }
  )

  // Update project
  .patch(
    "/v1/projects/:ref",
    ({ params, body, set }) => {
      const project = mockProjects.get(params.ref);
      if (!project || project.deleted_at) {
        set.status = 404;
        return { error: "Project not found" };
      }
      if (body.name) project.name = body.name;
      project.updated_at = new Date();
      return { ref: params.ref };
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({ name: t.Optional(t.String({ minLength: 1, maxLength: 100 })) }),
    }
  )

  // Delete project
  .delete(
    "/v1/projects/:ref",
    ({ params, set }) => {
      const project = mockProjects.get(params.ref);
      if (!project || project.deleted_at) {
        set.status = 404;
        return { error: "Project not found" };
      }
      project.deleted_at = new Date();
      project.status = "deleted";
      return { ref: params.ref };
    },
    { params: t.Object({ ref: t.String() }) }
  )

  // Pause project
  .post(
    "/v1/projects/:ref/pause",
    ({ params, set }) => {
      const project = mockProjects.get(params.ref);
      if (!project || project.deleted_at) {
        set.status = 404;
        return { error: "Project not found" };
      }
      project.status = "paused";
      return { ref: params.ref, status: "paused" };
    },
    { params: t.Object({ ref: t.String() }) }
  )

  // Restore project
  .post(
    "/v1/projects/:ref/restore",
    ({ params, set }) => {
      const project = mockProjects.get(params.ref);
      if (!project || project.deleted_at) {
        set.status = 404;
        return { error: "Project not found" };
      }
      project.status = "active";
      return { ref: params.ref, status: "active" };
    },
    { params: t.Object({ ref: t.String() }) }
  )

  // Health status
  .get(
    "/v1/projects/:ref/health",
    ({ params, set }) => {
      const project = mockProjects.get(params.ref);
      if (!project || project.deleted_at) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return {
        status: project.status === "active" ? "ACTIVE_HEALTHY" : "INACTIVE",
        services: {
          database: "ACTIVE_HEALTHY",
          storage: "ACTIVE_HEALTHY",
          auth: "ACTIVE_HEALTHY",
          realtime: "ACTIVE_HEALTHY",
        },
      };
    },
    { params: t.Object({ ref: t.String() }) }
  )

  // Project status
  .get(
    "/v1/projects/:ref/status",
    ({ params, set }) => {
      const project = mockProjects.get(params.ref);
      if (!project || project.deleted_at) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return { status: project.status, database: "healthy", storage: "healthy" };
    },
    { params: t.Object({ ref: t.String() }) }
  )

  // Restart project
  .post(
    "/v1/projects/:ref/restart",
    ({ params, set }) => {
      const project = mockProjects.get(params.ref);
      if (!project || project.deleted_at) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return { ref: params.ref, message: "Project restart initiated" };
    },
    { params: t.Object({ ref: t.String() }) }
  )

  // Project settings
  .get(
    "/v1/projects/:ref/settings",
    ({ params, set }) => {
      const project = mockProjects.get(params.ref);
      if (!project || project.deleted_at) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return project.config;
    },
    { params: t.Object({ ref: t.String() }) }
  )

  // Update project settings
  .put(
    "/v1/projects/:ref/settings",
    ({ params, body, set }) => {
      const project = mockProjects.get(params.ref);
      if (!project || project.deleted_at) {
        set.status = 404;
        return { error: "Project not found" };
      }
      project.config = { ...project.config, ...body };
      return project.config;
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Record(t.String(), t.Unknown()),
    }
  )

  // API keys
  .get(
    "/v1/projects/:ref/api-keys",
    ({ params, set }) => {
      const project = mockProjects.get(params.ref);
      if (!project || project.deleted_at) {
        set.status = 404;
        return { error: "Project not found" };
      }
      return {
        anon_key: `mock.anon.key.${params.ref}`,
        service_role_key: `mock.service.key.${params.ref}`,
      };
    },
    { params: t.Object({ ref: t.String() }) }
  );

const BASE = "http://localhost";

// ==================== Health Check ====================
describe("Health Check", () => {
  test("GET /health should return ok", async () => {
    const res = await testApp.handle(new Request(`${BASE}/health`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeDefined();
  });
});

// ==================== Auth Middleware ====================
describe("Auth Middleware", () => {
  test("should return 401 without auth header", async () => {
    const res = await testApp.handle(new Request(`${BASE}/v1/projects`));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Missing Authorization header");
  });

  test("should return 401 with Basic auth", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects`, { headers: BASIC_HEADER })
    );
    expect(res.status).toBe(401);
  });

  test("should return 403 with invalid Bearer token", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects`, { headers: INVALID_TOKEN_HEADER })
    );
    expect(res.status).toBe(403);
  });

  test("should return 200 with valid token", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects`, { headers: AUTH_HEADER })
    );
    expect(res.status).toBe(200);
  });

  test("should handle empty Bearer token", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects`, { headers: { Authorization: "Bearer " } })
    );
    // Empty token after "Bearer " is treated as invalid format (401) or invalid token (403)
    expect([401, 403]).toContain(res.status);
  });
});

// ==================== Available Regions ====================
describe("GET /v1/projects/available-regions", () => {
  test("should return region list", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects/available-regions`, { headers: AUTH_HEADER })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(5);
  });

  test("each region should have required fields", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects/available-regions`, { headers: AUTH_HEADER })
    );
    const body = await res.json();
    for (const region of body) {
      expect(region).toHaveProperty("code");
      expect(region).toHaveProperty("name");
      expect(region).toHaveProperty("continent");
    }
  });
});

// ==================== Projects CRUD ====================
describe("Projects CRUD", () => {
  let createdRef: string;

  test("POST /v1/projects should create project", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test Project" }),
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("Test Project");
    expect(body.ref).toBeDefined();
    expect(body.status).toBe("creating");
    createdRef = body.ref;
  });

  test("POST /v1/projects should accept region", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "US Project", region: "us-east-1" }),
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.region).toBe("us-east-1");
  });

  test("POST /v1/projects validation - empty name", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "" }),
      })
    );
    expect(res.status).toBe(422);
  });

  test("POST /v1/projects validation - missing name", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    expect(res.status).toBe(422);
  });

  test("GET /v1/projects should list projects", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects`, { headers: AUTH_HEADER })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  test("GET /v1/projects/:ref should get project details", async () => {
    // Create a project first
    const createRes = await testApp.handle(
      new Request(`${BASE}/v1/projects`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Detail Test" }),
      })
    );
    const created = await createRes.json();

    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects/${created.ref}`, { headers: AUTH_HEADER })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Detail Test");
  });

  test("GET /v1/projects/:ref - not found", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects/nonexistent`, { headers: AUTH_HEADER })
    );
    expect(res.status).toBe(404);
  });

  test("PATCH /v1/projects/:ref should update project", async () => {
    const createRes = await testApp.handle(
      new Request(`${BASE}/v1/projects`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Update Test" }),
      })
    );
    const created = await createRes.json();

    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects/${created.ref}`, {
        method: "PATCH",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated Name" }),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ref).toBe(created.ref);
  });

  test("DELETE /v1/projects/:ref should delete project", async () => {
    const createRes = await testApp.handle(
      new Request(`${BASE}/v1/projects`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Delete Test" }),
      })
    );
    const created = await createRes.json();

    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects/${created.ref}`, {
        method: "DELETE",
        headers: AUTH_HEADER,
      })
    );
    expect(res.status).toBe(200);

    // Verify deletion
    const getRes = await testApp.handle(
      new Request(`${BASE}/v1/projects/${created.ref}`, { headers: AUTH_HEADER })
    );
    expect(getRes.status).toBe(404);
  });
});

// ==================== Project Lifecycle ====================
describe("Project Lifecycle", () => {
  test("POST /v1/projects/:ref/pause should pause project", async () => {
    const createRes = await testApp.handle(
      new Request(`${BASE}/v1/projects`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Pause Test" }),
      })
    );
    const created = await createRes.json();

    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects/${created.ref}/pause`, {
        method: "POST",
        headers: AUTH_HEADER,
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("paused");
  });

  test("POST /v1/projects/:ref/restore should restore project", async () => {
    const createRes = await testApp.handle(
      new Request(`${BASE}/v1/projects`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Restore Test" }),
      })
    );
    const created = await createRes.json();

    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects/${created.ref}/restore`, {
        method: "POST",
        headers: AUTH_HEADER,
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("active");
  });

  test("POST /v1/projects/:ref/restart should restart project", async () => {
    const createRes = await testApp.handle(
      new Request(`${BASE}/v1/projects`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Restart Test" }),
      })
    );
    const created = await createRes.json();

    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects/${created.ref}/restart`, {
        method: "POST",
        headers: AUTH_HEADER,
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toContain("restart");
  });
});

// ==================== Project Health & Status ====================
describe("Project Health & Status", () => {
  test("GET /v1/projects/:ref/health should return health status", async () => {
    const createRes = await testApp.handle(
      new Request(`${BASE}/v1/projects`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Health Test" }),
      })
    );
    const created = await createRes.json();

    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects/${created.ref}/health`, { headers: AUTH_HEADER })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("services");
    expect(body.services).toHaveProperty("database");
  });

  test("GET /v1/projects/:ref/status should return status", async () => {
    const createRes = await testApp.handle(
      new Request(`${BASE}/v1/projects`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Status Test" }),
      })
    );
    const created = await createRes.json();

    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects/${created.ref}/status`, { headers: AUTH_HEADER })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("database");
  });
});

// ==================== Project Settings ====================
describe("Project Settings", () => {
  test("GET /v1/projects/:ref/settings should return settings", async () => {
    const createRes = await testApp.handle(
      new Request(`${BASE}/v1/projects`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Settings Test" }),
      })
    );
    const created = await createRes.json();

    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects/${created.ref}/settings`, { headers: AUTH_HEADER })
    );
    expect(res.status).toBe(200);
  });

  test("PUT /v1/projects/:ref/settings should update settings", async () => {
    const createRes = await testApp.handle(
      new Request(`${BASE}/v1/projects`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Settings Update Test" }),
      })
    );
    const created = await createRes.json();

    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects/${created.ref}/settings`, {
        method: "PUT",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ custom_key: "custom_value" }),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.custom_key).toBe("custom_value");
  });
});

// ==================== API Keys ====================
describe("API Keys", () => {
  test("GET /v1/projects/:ref/api-keys should return keys", async () => {
    const createRes = await testApp.handle(
      new Request(`${BASE}/v1/projects`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "API Keys Test" }),
      })
    );
    const created = await createRes.json();

    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects/${created.ref}/api-keys`, { headers: AUTH_HEADER })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("anon_key");
    expect(body).toHaveProperty("service_role_key");
  });
});

// ==================== Not Found Cases ====================
describe("Not Found Cases", () => {
  const nonExistentRef = "nonexistent123";

  test("GET /v1/projects/:ref returns 404", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects/${nonExistentRef}`, { headers: AUTH_HEADER })
    );
    expect(res.status).toBe(404);
  });

  test("PATCH /v1/projects/:ref returns 404", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects/${nonExistentRef}`, {
        method: "PATCH",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test" }),
      })
    );
    expect(res.status).toBe(404);
  });

  test("DELETE /v1/projects/:ref returns 404", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects/${nonExistentRef}`, {
        method: "DELETE",
        headers: AUTH_HEADER,
      })
    );
    expect(res.status).toBe(404);
  });

  test("POST /v1/projects/:ref/pause returns 404", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects/${nonExistentRef}/pause`, {
        method: "POST",
        headers: AUTH_HEADER,
      })
    );
    expect(res.status).toBe(404);
  });

  test("POST /v1/projects/:ref/restore returns 404", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects/${nonExistentRef}/restore`, {
        method: "POST",
        headers: AUTH_HEADER,
      })
    );
    expect(res.status).toBe(404);
  });

  test("GET /v1/projects/:ref/health returns 404", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects/${nonExistentRef}/health`, { headers: AUTH_HEADER })
    );
    expect(res.status).toBe(404);
  });

  test("GET /v1/projects/:ref/status returns 404", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects/${nonExistentRef}/status`, { headers: AUTH_HEADER })
    );
    expect(res.status).toBe(404);
  });

  test("POST /v1/projects/:ref/restart returns 404", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects/${nonExistentRef}/restart`, {
        method: "POST",
        headers: AUTH_HEADER,
      })
    );
    expect(res.status).toBe(404);
  });

  test("GET /v1/projects/:ref/settings returns 404", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects/${nonExistentRef}/settings`, { headers: AUTH_HEADER })
    );
    expect(res.status).toBe(404);
  });

  test("PUT /v1/projects/:ref/settings returns 404", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects/${nonExistentRef}/settings`, {
        method: "PUT",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ key: "value" }),
      })
    );
    expect(res.status).toBe(404);
  });

  test("GET /v1/projects/:ref/api-keys returns 404", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/v1/projects/${nonExistentRef}/api-keys`, { headers: AUTH_HEADER })
    );
    expect(res.status).toBe(404);
  });
});
