import { customAlphabet, nanoid as originalNanoid } from "nanoid";
import {
  generatePublishableApiKey,
  generateSecretApiKey,
} from "../utils/api-keys";

// Supabase OpenAPI requires a 20-character lowercase project ref (`^[a-z]+$`).
const generateProjectRefId = customAlphabet("abcdefghijklmnopqrstuvwxyz", 20);

// JWT Header
const header = {
  alg: "HS256",
  typ: "JWT",
};

// Base64URL encoding
function base64UrlEncode(data: string | Uint8Array): string {
  const base64 = typeof data === "string"
    ? btoa(data)
    : btoa(String.fromCharCode(...data));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// HMAC-SHA256 signature
async function sign(message: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return base64UrlEncode(new Uint8Array(signature));
}

// Generate JWT
async function generateJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const message = `${encodedHeader}.${encodedPayload}`;
  const signature = await sign(message, secret);
  return `${message}.${signature}`;
}

export class JwtService {
  // Generate random JWT Secret (32+ characters)
  generateSecret(): string {
    return process.env.TEST_FIXED_JWT_SECRET || originalNanoid(40);
  }

  // Generate project reference ID (20 lowercase letters to match official OpenAPI)
  generateProjectRef(): string {
    return generateProjectRefId();
  }

  // Generate anon key
  async generateAnonKey(jwtSecret: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      role: "anon",
      iss: "supabase",
      iat: now,
      exp: now + 10 * 365 * 24 * 60 * 60, // 10 years
    };
    return generateJwt(payload, jwtSecret);
  }

  // Generate service_role key
  async generateServiceRoleKey(jwtSecret: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      role: "service_role",
      iss: "supabase",
      iat: now,
      exp: now + 10 * 365 * 24 * 60 * 60, // 10 years
    };
    return generateJwt(payload, jwtSecret);
  }

  generateOpaqueKeySet(): {
    publishableKey: string;
    secretKey: string;
  } {
    return {
      publishableKey: generatePublishableApiKey(),
      secretKey: generateSecretApiKey(),
    };
  }

  // Generate complete JWT key set
  async generateKeySet(): Promise<{
    jwtSecret: string;
    anonKey: string;
    serviceRoleKey: string;
    publishableKey: string;
    secretKey: string;
  }> {
    const jwtSecret = this.generateSecret();
    const [anonKey, serviceRoleKey] = await Promise.all([
      this.generateAnonKey(jwtSecret),
      this.generateServiceRoleKey(jwtSecret),
    ]);
    return {
      jwtSecret,
      anonKey,
      serviceRoleKey,
      ...this.generateOpaqueKeySet(),
    };
  }
}

export const jwtService = new JwtService();
