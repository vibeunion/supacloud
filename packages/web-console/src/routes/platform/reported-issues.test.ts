import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const backupsSource = readFileSync(new URL("backups/+page.svelte", import.meta.url), "utf8");
const cacheSource = readFileSync(new URL("cache/+page.svelte", import.meta.url), "utf8");
const tuningSource = readFileSync(new URL("tuning/+page.svelte", import.meta.url), "utf8");
const operationsSource = readFileSync(new URL("operations/+page.svelte", import.meta.url), "utf8");
const diagnosticsSource = readFileSync(new URL("../../lib/components/DiagnosticsRunPanel.svelte", import.meta.url), "utf8");
const englishMessages = JSON.parse(readFileSync(new URL("../../lib/i18n/locales/en.json", import.meta.url), "utf8")) as Record<string, Record<string, string>>;
const chineseMessages = JSON.parse(readFileSync(new URL("../../lib/i18n/locales/zh.json", import.meta.url), "utf8")) as Record<string, Record<string, string>>;

function hasTranslation(messages: Record<string, Record<string, string>>, key: string): boolean {
  const [namespace, name] = key.split(".");
  return Boolean(messages[namespace]?.[name]);
}

describe("platform reported issue regressions", () => {
  test("blocks backup execution while pgBackRest is unavailable and gives deployment guidance", () => {
    expect(backupsSource).toContain("disabled={isCreating || backupServiceUnavailable}");
    expect(backupsSource).toContain('PlatformBackups.service_unavailable_guidance');
    expect(backupsSource).toContain('href="/platform/operations"');
  });

  test("gives the unconfigured cache runtime a safe configuration destination", () => {
    expect(cacheSource).toContain('docs/pgredis-runtime.md');
    expect(cacheSource).toContain('Cache.not_configured_guidance');
    expect(cacheSource).toContain('Cache.configuration_guide');
  });

  test("normalizes PostgreSQL page-unit memory settings before editing", () => {
    expect(tuningSource).toContain('return setting?.unit === "8kB";');
    expect(tuningSource).toContain('String(Math.round(pageCount / 128))');
    expect(tuningSource).toContain('return /^\\d+$/.test(inputValue) ? `${inputValue}MB` : null;');
    expect(tuningSource).toContain('inputmode={usesPageUnits(s) ? "numeric" : "text"}');
  });

  test("localizes health output, keeps dated operation logs, and balances the health grid", () => {
    expect(operationsSource).toContain('PlatformOperations.postgresql_ready');
    expect(operationsSource).toContain('PlatformOperations.standard_local_storage');
    expect(operationsSource).toContain('PlatformOperations.pigsty_ready');
    expect(operationsSource).toContain('new Date().toLocaleString()');
    expect(operationsSource).toContain('grid-cols-2 gap-3 md:grid-cols-3');
  });

  test("uses human-readable diagnostics labels and accounts for checks not run", () => {
    expect(diagnosticsSource).toContain('function notCheckedCount(): number');
    expect(diagnosticsSource).toContain('Diagnostics.not_checked');
    expect(diagnosticsSource).toContain('function runLabel(run: DiagnosticRun)');
    expect(diagnosticsSource).toContain('checkLabel(result.checkId)');
  });

  test("provides new platform guidance and status labels in both locales", () => {
    const requiredKeys = [
      "Platform.system_label",
      "Cache.configuration_guide",
      "PlatformBackups.service_unavailable",
      "PlatformTuning.memory_value_invalid",
      "PlatformOperations.postgresql_ready",
      "PlatformOperations.pigsty_ready",
      "Diagnostics.not_checked",
      "Diagnostics.run_label",
    ];
    for (const key of requiredKeys) {
      expect(hasTranslation(englishMessages, key)).toBe(true);
      expect(hasTranslation(chineseMessages, key)).toBe(true);
    }
  });
});
