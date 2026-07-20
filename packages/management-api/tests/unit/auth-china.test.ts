import { describe, expect, test } from "bun:test";
import { chinaAuthInternals } from "../../src/routes/auth-china";

describe("china auth edge function generators", () => {
  test("generated provider login function uses Bun-native default handler", () => {
    const functionCode = chinaAuthInternals.generateChinaOAuthFunction(
      "alipay",
      "app-id",
      "secret",
      "https://example.com/callback"
    );

    expect(functionCode).toContain("export default async function handler(req: Request)");
    expect(functionCode).not.toContain("Deno.serve");
    expect(functionCode).toContain("Bun.env[\"SUPABASE_URL\"]");
    expect(functionCode).toContain("JSON.stringify(finalSession)");
    expect(functionCode).not.toContain('import { SQL } from "bun"');
    expect(functionCode).not.toContain("SUPABASE_DB_URL");
    expect(functionCode).not.toContain("auth.identities");
    expect(functionCode).not.toContain("Identity linkage failed");
    expect(functionCode).not.toContain("app_metadata:");
  });
});
