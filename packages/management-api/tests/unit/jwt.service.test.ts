import { describe, test, expect, beforeAll, mock } from "bun:test";
mock.restore();
import { jwtService } from "../../src/services/jwt.service";

describe("JwtService", () => {
  beforeAll(() => {
    delete process.env.TEST_FIXED_JWT_SECRET;
  });

  describe("generateSecret", () => {
    test("should return a string with 40 characters", () => {
      const secret = jwtService.generateSecret();
      expect(typeof secret).toBe("string");
      expect(secret.length).toBe(40);
    });

    test("should generate unique secrets", () => {
      const secrets = new Set<string>();
      for (let i = 0; i < 100; i++) {
        secrets.add(jwtService.generateSecret());
      }
      expect(secrets.size).toBe(100);
    });

    test("should only contain alphanumeric and dash/underscore", () => {
      const secret = jwtService.generateSecret();
      // nanoid 默认使用 URL-safe 字符
      expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe("generateProjectRef", () => {
    test("should return a lowercase string with 20 characters", () => {
      const ref = jwtService.generateProjectRef();
      expect(typeof ref).toBe("string");
      expect(ref.length).toBe(20);
      expect(ref).toBe(ref.toLowerCase());
      expect(ref).toMatch(/^[a-z]+$/);
    });

    test("should generate unique refs", () => {
      const refs = new Set<string>();
      for (let i = 0; i < 100; i++) {
        refs.add(jwtService.generateProjectRef());
      }
      expect(refs.size).toBe(100);
    });
  });

  describe("generateAnonKey", () => {
    test("should return a valid JWT", async () => {
      const secret = jwtService.generateSecret();
      const anonKey = await jwtService.generateAnonKey(secret);

      expect(typeof anonKey).toBe("string");
      const parts = anonKey.split(".");
      expect(parts.length).toBe(3);
    });

    test("should have correct header", async () => {
      const secret = jwtService.generateSecret();
      const anonKey = await jwtService.generateAnonKey(secret);
      const parts = anonKey.split(".");

      const header = JSON.parse(atob(parts[0].replace(/-/g, "+").replace(/_/g, "/")));
      expect(header.alg).toBe("HS256");
      expect(header.typ).toBe("JWT");
    });

    test("should have anon role in payload", async () => {
      const secret = jwtService.generateSecret();
      const anonKey = await jwtService.generateAnonKey(secret);
      const parts = anonKey.split(".");

      const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
      expect(payload.role).toBe("anon");
      expect(payload.iss).toBe("supabase");
    });

    test("should have valid timestamps", async () => {
      const secret = jwtService.generateSecret();
      const anonKey = await jwtService.generateAnonKey(secret);
      const parts = anonKey.split(".");

      const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
      expect(payload.iat).toBeDefined();
      expect(payload.exp).toBeDefined();
      expect(payload.exp).toBeGreaterThan(payload.iat);
    });

    test("should have 10 year expiry", async () => {
      const secret = jwtService.generateSecret();
      const anonKey = await jwtService.generateAnonKey(secret);
      const parts = anonKey.split(".");

      const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
      const tenYearsInSeconds = 10 * 365 * 24 * 60 * 60;
      expect(payload.exp - payload.iat).toBe(tenYearsInSeconds);
    });
  });

  describe("generateServiceRoleKey", () => {
    test("should return a valid JWT", async () => {
      const secret = jwtService.generateSecret();
      const serviceRoleKey = await jwtService.generateServiceRoleKey(secret);

      expect(typeof serviceRoleKey).toBe("string");
      const parts = serviceRoleKey.split(".");
      expect(parts.length).toBe(3);
    });

    test("should have service_role in payload", async () => {
      const secret = jwtService.generateSecret();
      const serviceRoleKey = await jwtService.generateServiceRoleKey(secret);
      const parts = serviceRoleKey.split(".");

      const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
      expect(payload.role).toBe("service_role");
      expect(payload.iss).toBe("supabase");
    });

    test("should have different signature than anon key", async () => {
      const secret = jwtService.generateSecret();
      const anonKey = await jwtService.generateAnonKey(secret);
      const serviceRoleKey = await jwtService.generateServiceRoleKey(secret);

      expect(anonKey).not.toBe(serviceRoleKey);
    });
  });

  describe("generateKeySet", () => {
    test("should return legacy and opaque API keys", async () => {
      const keySet = await jwtService.generateKeySet();

      expect(keySet.jwtSecret).toBeDefined();
      expect(keySet.anonKey).toBeDefined();
      expect(keySet.serviceRoleKey).toBeDefined();
      expect(keySet.publishableKey).toMatch(/^sb_publishable_[A-Za-z0-9_-]+$/);
      expect(keySet.secretKey).toMatch(/^sb_secret_[A-Za-z0-9_-]+$/);
    });

    test("should have correct secret length", async () => {
      const keySet = await jwtService.generateKeySet();
      expect(keySet.jwtSecret.length).toBe(40);
    });

    test("should have valid JWTs", async () => {
      const keySet = await jwtService.generateKeySet();
      expect(keySet.anonKey.split(".").length).toBe(3);
      expect(keySet.serviceRoleKey.split(".").length).toBe(3);
    });

    test("should generate unique key sets", async () => {
      const keySet1 = await jwtService.generateKeySet();
      const keySet2 = await jwtService.generateKeySet();

      expect(keySet1.jwtSecret).not.toBe(keySet2.jwtSecret);
      expect(keySet1.anonKey).not.toBe(keySet2.anonKey);
      expect(keySet1.serviceRoleKey).not.toBe(keySet2.serviceRoleKey);
      expect(keySet1.publishableKey).not.toBe(keySet2.publishableKey);
      expect(keySet1.secretKey).not.toBe(keySet2.secretKey);
    });

    test("keys should be generated with the same secret", async () => {
      const keySet = await jwtService.generateKeySet();

      // 使用相同的 secret 应该能验证签名
      const anonParts = keySet.anonKey.split(".");
      const serviceParts = keySet.serviceRoleKey.split(".");

      // Header should be the same
      expect(anonParts[0]).toBe(serviceParts[0]);
    });
  });

  describe("generateOpaqueKeySet", () => {
    test("should rotate opaque keys without generating a JWT secret", () => {
      const keySet = jwtService.generateOpaqueKeySet();
      expect(keySet.publishableKey).toMatch(/^sb_publishable_[A-Za-z0-9_-]+$/);
      expect(keySet.secretKey).toMatch(/^sb_secret_[A-Za-z0-9_-]+$/);
      expect(keySet).not.toHaveProperty("jwtSecret");
    });
  });
});
