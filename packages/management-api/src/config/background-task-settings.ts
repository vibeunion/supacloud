export const DEFAULT_BACKGROUND_TASK_SETTINGS = {
  concurrency: 20,
  max_attempts: 3,
  max_payload_bytes: 256 * 1024,
  timeout_sec_default: 300,
  timeout_sec_max: 900,
} as const;

export const BACKGROUND_TASK_SETTING_LIMITS = {
  concurrency: { min: 1, max: 20 },
  max_attempts: { min: 1, max: 10 },
  max_payload_bytes: { min: 1024, max: 1024 * 1024 },
  timeout_sec_default: { min: 1, max: 900 },
  timeout_sec_max: { min: 1, max: 1800 },
} as const;
