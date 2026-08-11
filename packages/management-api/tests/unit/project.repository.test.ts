import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

mock.restore();

// Mock the SQL module
const mockProject = {
  id: "uuid-test123",
  ref: "test123",
  organization_id: "default",
  name: "Test Project",
  db_name: "supa_test123",
  db_user: "role_test123",
  db_password: "password123",
  jwt_secret: "secret123",
  anon_key: "anon.key.test",
  service_role_key: "service.key.test",
  s3_bucket: "supa-test123",
  s3_access_key: "access123",
  s3_secret_key: "secret123",
  status: "active" as const,
  region: "local",
  config: {},
  created_at: new Date(),
  updated_at: new Date(),
  deleted_at: null,
};

// Mock the SQL module
const mockSql: unknown = mock(() => Promise.resolve([]));
(mockSql as Record<string, unknown>).unsafe = mock(() => Promise.resolve([]));
const mockTransactionSql = mock(() => Promise.resolve([]));
(mockSql as Record<string, unknown>).begin = mock(
  (callback: (tx: typeof mockTransactionSql) => Promise<unknown>) => callback(mockTransactionSql),
);

mock.module("../../src/db", () => ({
  sql: mockSql,
}));

// Import the object after mocking and after clearing any cross-file mock cache.
const { projectRepository } = await import(
  new URL("../../src/repositories/project.repository.ts?project-repository-test", import.meta.url)
    .href
);

describe("ProjectRepository", () => {
  beforeEach(() => {
    (mockSql as ReturnType<typeof mock>).mockClear();
    ((mockSql as Record<string, unknown>).unsafe as ReturnType<typeof mock>).mockClear();
    ((mockSql as Record<string, unknown>).begin as ReturnType<typeof mock>).mockClear();
    mockTransactionSql.mockClear();
  });

  describe("findAll", () => {
    test("should return all non-deleted projects", async () => {
      (mockSql as ReturnType<typeof mock>).mockResolvedValueOnce([mockProject]);
      const projects = await projectRepository.findAll();
      expect(Array.isArray(projects)).toBe(true);
    });

    test("should return empty array when no projects", async () => {
      (mockSql as ReturnType<typeof mock>).mockResolvedValueOnce([]);
      const projects = await projectRepository.findAll();
      expect(projects).toEqual([]);
    });
  });

  describe("findByRef", () => {
    test("should return project when found", async () => {
      (mockSql as ReturnType<typeof mock>).mockResolvedValueOnce([mockProject]);
      const project = await projectRepository.findByRef("test123");
      expect(project).toBeDefined();
    });

    test("should return null when not found", async () => {
      (mockSql as ReturnType<typeof mock>).mockResolvedValueOnce([]);
      const project = await projectRepository.findByRef("nonexistent");
      expect(project).toBeNull();
    });
  });

  describe("findById", () => {
    test("should return project when found", async () => {
      (mockSql as ReturnType<typeof mock>).mockResolvedValueOnce([mockProject]);
      const project = await projectRepository.findById("uuid-test123");
      expect(project).toBeDefined();
    });

    test("should return null when not found", async () => {
      (mockSql as ReturnType<typeof mock>).mockResolvedValueOnce([]);
      const project = await projectRepository.findById("nonexistent-uuid");
      expect(project).toBeNull();
    });
  });

  describe("create", () => {
    test("should create and return project", async () => {
      (mockSql as ReturnType<typeof mock>).mockResolvedValueOnce([mockProject]);
      const input = {
        ref: "newproj",
        name: "New Project",
        db_name: "supa_newproj",
        db_user: "role_newproj",
        db_password: "pass123",
        jwt_secret: "jwt123",
        anon_key: "anon.new",
        service_role_key: "service.new",
        s3_bucket: "supa-newproj",
        region: "local",
      };
      const project = await projectRepository.create(input);
      expect(project).toBeDefined();
    });

    test("should handle optional s3 keys", async () => {
      (mockSql as ReturnType<typeof mock>).mockResolvedValueOnce([mockProject]);
      const input = {
        ref: "newproj",
        name: "New Project",
        db_name: "supa_newproj",
        db_user: "role_newproj",
        db_password: "pass123",
        jwt_secret: "jwt123",
        anon_key: "anon.new",
        service_role_key: "service.new",
        s3_bucket: "supa-newproj",
        s3_access_key: "access",
        s3_secret_key: "secret",
      };
      const project = await projectRepository.create(input);
      expect(project).toBeDefined();
    });

    test("should handle config option", async () => {
      (mockSql as ReturnType<typeof mock>).mockResolvedValueOnce([mockProject]);
      const input = {
        ref: "newproj",
        name: "New Project",
        db_name: "supa_newproj",
        db_user: "role_newproj",
        db_password: "pass123",
        jwt_secret: "jwt123",
        anon_key: "anon.new",
        service_role_key: "service.new",
        s3_bucket: "supa-newproj",
        config: { custom: "value" },
      };
      const project = await projectRepository.create(input);
      expect(project).toBeDefined();
    });
  });

  describe("updateStatus", () => {
    test("should update and return project", async () => {
      const updatedProject = { ...mockProject, status: "paused" as const };
      (mockSql as ReturnType<typeof mock>).mockResolvedValueOnce([updatedProject]);
      const project = await projectRepository.updateStatus("test123", "paused");
      expect(project).toBeDefined();
    });

    test("should return null when project not found", async () => {
      (mockSql as ReturnType<typeof mock>).mockResolvedValueOnce([]);
      const project = await projectRepository.updateStatus("nonexistent", "paused");
      expect(project).toBeNull();
    });
  });

  describe("updateConfig", () => {
    test("should update and return project", async () => {
      const updatedProject = { ...mockProject, config: { key: "value" } };
      (mockSql as ReturnType<typeof mock>).mockResolvedValueOnce([updatedProject]);
      const project = await projectRepository.updateConfig("test123", { key: "value" });
      expect(project).toBeDefined();
    });

    test("preserves the database-owned scheduled function config in the update SQL", async () => {
      const staleSchedule = { id: "stale-schedule" };
      const inputConfig = { key: "value", scheduled_functions: [staleSchedule] };
      (mockSql as ReturnType<typeof mock>).mockResolvedValueOnce([mockProject]);

      await projectRepository.updateConfig("test123", inputConfig);

      const [strings, serializedConfig] = (mockSql as ReturnType<typeof mock>).mock.calls[0];
      const query = (strings as TemplateStringsArray).join("?").replaceAll(/\s+/g, " ").trim();
      expect(query).toContain("WHEN 'object' THEN ?::jsonb - 'scheduled_functions'");
      expect(query).toContain("jsonb_typeof(projects.config) = 'object'");
      expect(query).toContain("projects.config ? 'scheduled_functions'");
      expect(query).toContain("jsonb_build_object('scheduled_functions', projects.config -> 'scheduled_functions')");
      expect(serializedConfig).toBe(JSON.stringify(inputConfig));
    });

    test("should return null when project not found", async () => {
      (mockSql as ReturnType<typeof mock>).mockResolvedValueOnce([]);
      const project = await projectRepository.updateConfig("nonexistent", { key: "value" });
      expect(project).toBeNull();
    });
  });

  describe("softDelete", () => {
    test("should soft delete and return project", async () => {
      const deletedProject = { ...mockProject, status: "deleted" as const, deleted_at: new Date() };
      (mockSql as ReturnType<typeof mock>).mockResolvedValueOnce([deletedProject]);
      const project = await projectRepository.softDelete("test123");
      expect(project).toBeDefined();
    });

    test("should return null when project not found", async () => {
      (mockSql as ReturnType<typeof mock>).mockResolvedValueOnce([]);
      const project = await projectRepository.softDelete("nonexistent");
      expect(project).toBeNull();
    });
  });

  describe("updateOpaqueApiKeys", () => {
    test("atomically updates metadata and runtime secrets", async () => {
      mockTransactionSql
        .mockResolvedValueOnce([mockProject])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const project = await projectRepository.updateOpaqueApiKeys("test123", {
        publishable_key: "sb_publishable_new",
        secret_key: "sb_secret_new",
      });

      expect(project).toEqual(mockProject);
      expect((mockSql as Record<string, unknown>).begin).toHaveBeenCalledTimes(1);
      expect(mockTransactionSql).toHaveBeenCalledTimes(3);
    });
  });

  describe("existsByRef", () => {
    test("should return true when ref exists", async () => {
      (mockSql as ReturnType<typeof mock>).mockResolvedValueOnce([{ "?column?": 1 }]);
      const exists = await projectRepository.existsByRef("test123");
      expect(exists).toBe(true);
    });

    test("should return false when ref does not exist", async () => {
      (mockSql as ReturnType<typeof mock>).mockResolvedValueOnce([]);
      const exists = await projectRepository.existsByRef("nonexistent");
      expect(exists).toBe(false);
    });
  });
});
