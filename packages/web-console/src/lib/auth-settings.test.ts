import { expect, test } from "bun:test";
import {
  parseProtectionSettings, parseProviderReceipt, parseStudioProviders,
  emailTemplateIds, parseEmailTemplates, parseEmailTemplateReceipt,
  parseRateLimitSettings, rateLimitPatch, parseRateLimitReceipt, type RateLimitEdit,
} from "./auth-settings";

test("rate limits preserve absent values and accept only non-negative safe integers", () => {
  expect(parseRateLimitSettings({ RATE_LIMIT_SIGNIN: "0", RATE_LIMIT_SIGNUP: 12, unused: {} }))
    .toEqual({ RATE_LIMIT_SIGNIN: 0, RATE_LIMIT_SIGNUP: 12 });
  expect(parseRateLimitSettings({})).toEqual({});
  expect(parseRateLimitSettings({ RATE_LIMIT_SIGNIN: String(Number.MAX_SAFE_INTEGER) }))
    .toEqual({ RATE_LIMIT_SIGNIN: Number.MAX_SAFE_INTEGER });
  for (const value of [null, [], false, "config"]) {
    expect(() => parseRateLimitSettings(value)).toThrow();
  }
  for (const value of [undefined, null, [], {}, true, "", " 1", "1 ", "1e2", "0x10", "01",
    "+1", "-1", "1.0", 0.5, -1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "9007199254740993"]) {
    expect(() => parseRateLimitSettings({ RATE_LIMIT_SIGNIN: value })).toThrow();
  }
});

test("rate limit patches copy changed values without populating missing settings", () => {
  const edits: RateLimitEdit[] = [
    { envKey: "RATE_LIMIT_SIGNIN", value: 0, original: 12 },
    { envKey: "RATE_LIMIT_SIGNUP", value: undefined, original: undefined },
    { envKey: "RATE_LIMIT_VERIFY", value: 30, original: 30 },
  ];
  const patch = rateLimitPatch(edits);
  expect(patch).toEqual({ RATE_LIMIT_SIGNIN: "0" });
  for (const edit of edits) edit.value = 90;
  expect(patch).toEqual({ RATE_LIMIT_SIGNIN: "0" });
  for (const value of [undefined, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => rateLimitPatch([{ envKey: "RATE_LIMIT_SIGNIN", value, original: 12 }])).toThrow();
  }
  expect(() => rateLimitPatch([
    { envKey: "RATE_LIMIT_SIGNIN", value: 1, original: 12 },
    { envKey: "RATE_LIMIT_SIGNIN", value: 2, original: 12 },
  ])).toThrow();
});

test("rate limit receipts require every submitted value and reject empty mutations", () => {
  const expected = { RATE_LIMIT_SIGNIN: "0", RATE_LIMIT_SIGNUP: "12" };
  expect(() => parseRateLimitReceipt({ RATE_LIMIT_SIGNIN: 0, RATE_LIMIT_SIGNUP: "12" }, expected))
    .not.toThrow();
  for (const value of [null, [], {}, { RATE_LIMIT_SIGNIN: 0 },
    { RATE_LIMIT_SIGNIN: 0, RATE_LIMIT_SIGNUP: 13 }, { RATE_LIMIT_SIGNIN: 0, RATE_LIMIT_SIGNUP: null }]) {
    expect(() => parseRateLimitReceipt(value, expected)).toThrow();
  }
  expect(() => parseRateLimitReceipt({}, {})).toThrow();
});

test("protection settings accept explicit booleans without coercing arbitrary input", () => {
  expect(parseProtectionSettings({ SECURITY_CAPTCHA_ENABLED: "false", PASSWORD_HIBC_ENABLE: true, unused: {} }))
    .toEqual({ SECURITY_CAPTCHA_ENABLED: false, PASSWORD_HIBC_ENABLE: true });
  expect(parseProtectionSettings({})).toEqual({});
  for (const value of [null, [], false, "settings", { SECURITY_CAPTCHA_ENABLED: 1 }, { SECURITY_CAPTCHA_ENABLED: null }]) {
    expect(() => parseProtectionSettings(value)).toThrow();
  }
});

test("provider configuration validates flags and strings and copies only public form fields", () => {
  const original = {
    providers: { github: { enabled: false, client_id: null, redirect_uri: null, client_secret: "must-not-copy" } },
  };
  expect(parseStudioProviders(original)).toEqual({
    github: { enabled: false, client_id: "", redirect_uri: "", auth_scheme: "" },
  });
  for (const value of [null, [], {}, { providers: [] }, { providers: { github: [] } },
    { providers: { github: { enabled: "false" } } }, { providers: { github: { enabled: true, client_id: {} } } }]) {
    expect(() => parseStudioProviders(value)).toThrow();
  }
});

test("provider receipts must match the requested identity and state and preserve runtime warnings", () => {
  expect(parseProviderReceipt({ id: "github", enabled: true }, "github", true)).toEqual({});
  expect(parseProviderReceipt({ provider: "github", enabled: true, warning: "Runtime unavailable" }, "github", true))
    .toEqual({ warning: "Runtime unavailable" });
  for (const value of [null, [], {}, { id: "other", enabled: true }, { id: "github", enabled: false },
    { id: "github", enabled: "true" }, { id: "github", enabled: true, warning: {} },
    { id: "github", enabled: true, provider: "other" }]) {
    expect(() => parseProviderReceipt(value, "github", true)).toThrow();
  }
});

test("email template parsing validates every field and binds save receipts to the submitted values", () => {
  const templates = Object.fromEntries(emailTemplateIds.map((id) => [id, { subject: id, content: "" }]));
  const decoded = parseEmailTemplates({ templates });
  expect(decoded).toHaveLength(6);
  expect(parseEmailTemplateReceipt({ saved: true, templates, warning: "Not applied" }, "save", decoded))
    .toEqual({ warning: "Not applied" });
  expect(parseEmailTemplateReceipt({ reset: true, templates }, "reset")).toEqual({});
  for (const value of [null, {}, { templates: [] }, { templates: {} },
    { templates: { ...templates, confirmation: { subject: 1, content: "" } } }]) {
    expect(() => parseEmailTemplates(value)).toThrow();
  }
  expect(() => parseEmailTemplateReceipt({ templates }, "save", decoded)).toThrow();
  expect(() => parseEmailTemplateReceipt({ saved: true, templates }, "save")).toThrow();
  expect(() => parseEmailTemplateReceipt({
    saved: true, templates: { ...templates, confirmation: { subject: "different", content: "" } },
  }, "save", decoded)).toThrow();
});
