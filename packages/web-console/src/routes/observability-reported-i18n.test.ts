import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const en = JSON.parse(readFileSync(new URL("../lib/i18n/locales/en.json", import.meta.url), "utf8"));
const zh = JSON.parse(readFileSync(new URL("../lib/i18n/locales/zh.json", import.meta.url), "utf8"));
const sources = [
  "project/[ref]/database/rls-tester/+page.svelte",
  "project/[ref]/database/temporary-access/+page.svelte",
  "project/[ref]/logs/+page.svelte",
  "project/[ref]/realtime/+page.svelte",
  "../lib/components/DiagnosticsRunPanel.svelte",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
const hanCharacters = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

function withoutComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("reported observability i18n contract", () => {
  test("keeps the affected pages free of hardcoded CJK copy", () => {
    for (const source of sources) expect(withoutComments(source)).not.toMatch(hanCharacters);
  });

  test("resolves static translation keys in both locales", () => {
    for (const source of sources) {
      for (const [, translationKey] of source.matchAll(/\$t\("([A-Za-z]+\.[A-Za-z_]+)"/g)) {
        const [section, key] = translationKey.split(".");
        expect(en[section][key]).toEqual(expect.any(String));
        expect(zh[section][key]).toEqual(expect.any(String));
      }
    }
  });

  test("loads Realtime table suggestions without removing wildcard or custom input", () => {
    const source = sources[3];

    expect(source).toContain("/database/tables?_page=1&_limit=200");
    expect(source).toContain('bind:value={pgTable} list="realtime-table-options"');
    expect(source).toContain('<option value="*"');
    expect(source).toContain("table.table_name");
  });

  test("localizes diagnostics statuses and log filters while retaining raw values", () => {
    const logsSource = sources[2];
    const diagnosticsSource = sources[4];

    expect(logsSource).toContain('value: "1h", labelKey: "ProjectLogs.range_1h"');
    expect(logsSource).toContain('value: "all", labelKey: "ProjectLogs.service_all"');
    expect(diagnosticsSource).toContain("runStatusLabel(run.status)");
    expect(diagnosticsSource).toContain("title={run.status}");
  });
});
