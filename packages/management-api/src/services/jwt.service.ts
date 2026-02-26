import { nanoid } from "nanoid";

// JWT Header
const header = {
  alg: "HS256",
  typ: "JWT",
};

// Base64URL 编码
function base64UrlEncode(data: string | Uint8Array): string {
  const base64 = typeof data === "string"
    ? btoa(data)
    : btoa(String.fromCharCode(...data));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// HMAC-SHA256 签名
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

// 生成 JWT
async function generateJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const message = `${encodedHeader}.${encodedPayload}`;
  const signature = await sign(message, secret);
  return `${message}.${signature}`;
}

export class JwtService {
  // 生成随机的 JWT Secret (32+ 字符)
  generateSecret(): string {
    return nanoid(40);
  }

  // 生成项目引用 ID (10 字符)
  generateProjectRef(): string {
    return nanoid(10).toLowerCase();
  }

  // 生成 anon key
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

  // 生成 service_role key
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

  // 生成完整的 JWT 密钥集
  async generateKeySet(): Promise<{
    jwtSecret: string;
    anonKey: string;
    serviceRoleKey: string;
  }> {
    const jwtSecret = this.generateSecret();
    const [anonKey, serviceRoleKey] = await Promise.all([
      this.generateAnonKey(jwtSecret),
      this.generateServiceRoleKey(jwtSecret),
    ]);
    return { jwtSecret, anonKey, serviceRoleKey };
  }
}

export const jwtService = new JwtService();
