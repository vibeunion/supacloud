import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// Mock the SQL module
const mockSql = mock(() => Promise.resolve([]));
mockSql.unsafe = mock(() => Promise.resolve([]));

mock.module("../../src/db", () => ({
  sql: mockSql,
}));

// Import after mocking
import { ProjectRepository } from "../../src/repositories/project.repository";

describe("ProjectRepository", () => {
  let repository: ProjectRepository;

  const mockProject = {
    id: "uuid-test123",
    ref: "test123",
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

  beforeEach(() => {
    repository = new ProjectRepository();
    mockSql.mockClear();
  });

  describe("findAll", () => {
    test("should return all non-deleted projects", async () => {
      mockSql.mockResolvedValueOnce([mockProject]);
      const projects = await repository.findAll();
      expect(Array.isArray(projects)).toBe(true);
    });

    test("should return empty array when no projects", async () => {
      mockSql.mockResolvedValueOnce([]);
      const projects = await repository.findAll();
      expect(projects).toEqual([]);
    });
  });

  describe("findByRef", () => {
    test("should return project when found", async () => {
      mockSql.mockResolvedValueOnce([mockProject]);
      const project = await repository.findByRef("test123");
      expect(project).toBeDefined();
    });

    test("should return null when not found", async () => {
      mockSql.mockResolvedValueOnce([]);
      const project = await repository.findByRef("nonexistent");
      expect(project).toBeNull();
    });
  });

  describe("findById", () => {
    test("should return project when found", async () => {
      mockSql.mockResolvedValueOnce([mockProject]);
      const project = await repository.findById("uuid-test123");
      expect(project).toBeDefined();
    });

    test("should return null when not found", async () => {
      mockSql.mockResolvedValueOnce([]);
      const project = await repository.findById("nonexistent-uuid");
      expect(project).toBeNull();
    });
  });

  describe("create", () => {
    test("should create and return project", async () => {
      mockSql.mockResolvedValueOnce([mockProject]);
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
      const project = await repository.create(input);
      expect(project).toBeDefined();
    });

    test("should handle optional s3 keys", async () => {
      mockSql.mockResolvedValueOnce([mockProject]);
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
      const project = await repository.create(input);
      expect(project).toBeDefined();
    });

    test("should handle config option", async () => {
      mockSql.mockResolvedValueOnce([mockProject]);
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
      const project = await repository.create(input);
      expect(project).toBeDefined();
    });
  });

  describe("updateStatus", () => {
    test("should update and return project", async () => {
      const updatedProject = { ...mockProject, status: "paused" as const };
      mockSql.mockResolvedValueOnce([updatedProject]);
      const project = await repository.updateStatus("test123", "paused");
      expect(project).toBeDefined();
    });

    test("should return null when project not found", async () => {
      mockSql.mockResolvedValueOnce([]);
      const project = await repository.updateStatus("nonexistent", "paused");
      expect(project).toBeNull();
    });
  });

  describe("updateConfig", () => {
    test("should update and return project", async () => {
      const updatedProject = { ...mockProject, config: { key: "value" } };
      mockSql.mockResolvedValueOnce([updatedProject]);
      const project = await repository.updateConfig("test123", { key: "value" });
      expect(project).toBeDefined();
    });

    test("should return null when project not found", async () => {
      mockSql.mockResolvedValueOnce([]);
      const project = await repository.updateConfig("nonexistent", { key: "value" });
      expect(project).toBeNull();
    });
  });

  describe("softDelete", () => {
    test("should soft delete and return project", async () => {
      const deletedProject = { ...mockProject, status: "deleted" as const, deleted_at: new Date() };
      mockSql.mockResolvedValueOnce([deletedProject]);
      const project = await repository.softDelete("test123");
      expect(project).toBeDefined();
    });

    test("should return null when project not found", async () => {
      mockSql.mockResolvedValueOnce([]);
      const project = await repository.softDelete("nonexistent");
      expect(project).toBeNull();
    });
  });

  describe("existsByRef", () => {
    test("should return true when ref exists", async () => {
      mockSql.mockResolvedValueOnce([{ "?column?": 1 }]);
      const exists = await repository.existsByRef("test123");
      expect(exists).toBe(true);
    });

    test("should return false when ref does not exist", async () => {
      mockSql.mockResolvedValueOnce([]);
      const exists = await repository.existsByRef("nonexistent");
      expect(exists).toBe(false);
    });
  });
});
