import { beforeEach, describe, expect, mock, test } from "bun:test";

type SettingRow = {
  key: string;
  value: string;
  description: string | null;
  is_secret: boolean;
  updated_at: Date;
};

const settings = new Map<string, SettingRow>();
let databaseError: Error | null = null;

function queryText(strings: TemplateStringsArray): string {
  return strings.join("?").replaceAll(/\s+/g, " ").trim();
}

const database = Object.assign(
  mock(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (databaseError) throw databaseError;
    const query = queryText(strings);
    if (query.includes("SELECT value, is_secret") && query.includes("FOR UPDATE")) {
      const row = settings.get(String(values[0]));
      return row ? [{ value: row.value, is_secret: row.is_secret }] : [];
    }
    if (query.startsWith("INSERT INTO platform_settings")) {
      settings.set(String(values[0]), {
        key: String(values[0]),
        value: String(values[1]),
        description: values[2] == null ? null : String(values[2]),
        is_secret: Boolean(values[3]),
        updated_at: new Date("2026-07-19T00:00:00.000Z"),
      });
      return [];
    }
    if (query.includes("SELECT key, value") && query.includes("ORDER BY key")) {
      return [...settings.values()].sort((left, right) => left.key.localeCompare(right.key));
    }
    if (query.includes("SELECT key, value") && query.includes("WHERE key")) {
      const row = settings.get(String(values[0]));
      return row ? [row] : [];
    }
    if (query.includes("SELECT value, is_secret") && query.includes("WHERE key")) {
      const row = settings.get(String(values[0]));
      return row ? [{ value: row.value, is_secret: row.is_secret }] : [];
    }
    return [];
  }),
  {
    begin: async (callback: (transaction: unknown) => Promise<unknown>) => callback(database),
  },
);

mock.module("../../src/db", () => ({ sql: database }));

const {
  getPlatformSetting,
  listPlatformSettings,
  updatePlatformSettings,
} = await import(new URL("../../src/services/platform-settings.service.ts?platform-settings-service-test", import.meta.url).href);

describe("platform settings secret storage", () => {
  beforeEach(() => {
    settings.clear();
    databaseError = null;
  });

  test("server-classifies and encrypts AI API keys while returning only masked state", async () => {
    await updatePlatformSettings([{
      key: "ai_api_key",
      value: "sk-secret-value",
      description: "AI key",
      is_secret: false,
    }]);

    const stored = settings.get("ai_api_key");
    expect(stored?.is_secret).toBe(true);
    expect(stored?.value).toStartWith("enc:v1:");
    expect(stored?.value).not.toContain("sk-secret-value");
    expect(await getPlatformSetting("ai_api_key")).toBe("sk-secret-value");
    expect(await listPlatformSettings()).toEqual([{
      ...stored,
      value: "********",
      configured: true,
    }]);
  });

  test("masked round-trips preserve the encrypted secret and cannot downgrade its classification", async () => {
    await updatePlatformSettings([{ key: "custom_secret", value: "first-value", is_secret: true }]);
    const ciphertext = settings.get("custom_secret")?.value;

    await updatePlatformSettings([{ key: "custom_secret", value: "********", is_secret: false }]);

    expect(settings.get("custom_secret")?.value).toBe(ciphertext);
    expect(settings.get("custom_secret")?.is_secret).toBe(true);
    expect(await getPlatformSetting("custom_secret")).toBe("first-value");
  });

  test("database failures propagate instead of becoming an empty setting", async () => {
    databaseError = new Error("database unavailable");
    await expect(getPlatformSetting("ai_api_key")).rejects.toThrow("database unavailable");
    await expect(listPlatformSettings()).rejects.toThrow("database unavailable");
  });
});
