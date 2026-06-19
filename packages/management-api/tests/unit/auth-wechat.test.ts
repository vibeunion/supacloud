import { describe, expect, test } from "bun:test";
import { wechatAuthInternals } from "../../src/routes/auth-wechat";

function expectWechatLoginResponseContract(functionCode: string) {
  expect(functionCode).toContain("export default async function handler(req: Request)");
  expect(functionCode).not.toContain("Deno.serve");
  expect(functionCode).toContain("const responseUser = finalSession.user ?? null");
  expect(functionCode).toContain("JSON.stringify({ data: { session: finalSession, user: responseUser } })");
  expect(functionCode).toContain("JSON.stringify({ data: { session: null, user: null }, error:");
  expect(functionCode).not.toContain("(finalSession as any).user");
}

describe("wechat auth edge function generators", () => {
  test("mini program login success response matches supabase-mp-js contract", () => {
    const functionCode = wechatAuthInternals.generateWeChatMiniProgramLoginFunction("app-id", "secret");

    expectWechatLoginResponseContract(functionCode);
  });

  test("official account login success response matches supabase-mp-js contract", () => {
    const functionCode = wechatAuthInternals.generateWeChatMPLoginFunction("app-id", "secret", "https://example.com/callback");

    expectWechatLoginResponseContract(functionCode);
  });
});
