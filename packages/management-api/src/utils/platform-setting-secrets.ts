export const SENSITIVE_PLATFORM_SETTING_KEYS = ["ai_api_key"] as const;

export function isSensitivePlatformSetting(key: string): boolean {
  return (SENSITIVE_PLATFORM_SETTING_KEYS as readonly string[]).includes(key);
}

export function isMaskedPlatformSecret(value: string): boolean {
  return value === "********";
}
