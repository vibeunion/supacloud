import { describe, test, expect } from "bun:test";
import { jwtService } from "../../src/services/jwt.service";

describe("JwtService", () => {
  test("generateSecret should return a string with 40 characters", () => {
    const secret = jwtService.generateSecret();
    expect(typeof secret).toBe("string");
    expect(secret.length).toBe(40);
  });

  test("generateProjectRef should return a lowercase string with 10 characters", () => {
    const ref = jwtService.generateProjectRef();
    expect(typeof ref).toBe("string");
    expect(ref.length).toBe(10);
    expect(ref).toBe(ref.toLowerCase());
  });

  test("generateAnonKey should return a valid JWT", async () => {
    const secret = jwtService.generateSecret();
    const anonKey = await jwtService.generateAnonKey(secret);

    expect(typeof anonKey).toBe("string");
    // JWT has 3 parts separated by dots
    const parts = anonKey.split(".");
    expect(parts.length).toBe(3);

    // Decode and verify payload
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    expect(payload.role).toBe("anon");
    expect(payload.iss).toBe("supabase");
  });

  test("generateServiceRoleKey should return a valid JWT with service_role", async () => {
    const secret = jwtService.generateSecret();
    const serviceRoleKey = await jwtService.generateServiceRoleKey(secret);

    expect(typeof serviceRoleKey).toBe("string");
    const parts = serviceRoleKey.split(".");
    expect(parts.length).toBe(3);

    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    expect(payload.role).toBe("service_role");
    expect(payload.iss).toBe("supabase");
  });

  test("generateKeySet should return all three keys", async () => {
    const keySet = await jwtService.generateKeySet();

    expect(keySet.jwtSecret).toBeDefined();
    expect(keySet.anonKey).toBeDefined();
    expect(keySet.serviceRoleKey).toBeDefined();

    expect(keySet.jwtSecret.length).toBe(40);
    expect(keySet.anonKey.split(".").length).toBe(3);
    expect(keySet.serviceRoleKey.split(".").length).toBe(3);
  });
});
