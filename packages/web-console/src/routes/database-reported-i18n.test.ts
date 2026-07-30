import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const en = JSON.parse(readFileSync(new URL("../lib/i18n/locales/en.json", import.meta.url), "utf8"));
const zh = JSON.parse(readFileSync(new URL("../lib/i18n/locales/zh.json", import.meta.url), "utf8"));
const pageNames = [
  "materialized-views",
  "roles",
  "column-privileges",
  "extensions",
  "publications",
  "hooks",
  "pipelines",
  "wrappers",
  "indexes",
  "sql",
];
const expectedObjects = [
  "MaterializedViews",
  "Roles",
  "ColumnPrivileges",
  "Extensions",
  "Publications",
  "Hooks",
  "Pipelines",
  "Wrappers",
  "Indexes",
];
const hanCharacters = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const projectSettingsSource = readFileSync(new URL("project/[ref]/settings/+page.svelte", import.meta.url), "utf8");

function withoutComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("reported database i18n contract", () => {
  test("keeps the reported database pages free of hardcoded CJK copy", () => {
    for (const pageName of pageNames) {
      const sourceUrl = pageName === "sql"
        ? new URL("project/[ref]/sql/+page.svelte", import.meta.url)
        : new URL(`project/[ref]/database/${pageName}/+page.svelte`, import.meta.url);
      const source = readFileSync(sourceUrl, "utf8");
      expect(withoutComments(source)).not.toMatch(hanCharacters);
    }
  });

  test("provides matching English and Chinese copy for each reported page", () => {
    for (const objectName of expectedObjects) {
      expect(en[objectName]).toEqual(expect.any(Object));
      expect(Object.keys(en[objectName]).sort()).toEqual(Object.keys(zh[objectName]).sort());
    }
  });

  test("resolves each literal translation key used by the reported pages", () => {
    for (const pageName of pageNames) {
      const sourceUrl = pageName === "sql"
        ? new URL("project/[ref]/sql/+page.svelte", import.meta.url)
        : new URL(`project/[ref]/database/${pageName}/+page.svelte`, import.meta.url);
      const source = readFileSync(sourceUrl, "utf8");
      for (const [, translationKey] of source.matchAll(/"([A-Za-z]+\.[A-Za-z_]+)"/g)) {
        const [section, key] = translationKey.split(".");
        expect(en[section][key]).toEqual(expect.any(String));
        expect(zh[section][key]).toEqual(expect.any(String));
      }
    }
  });

  test("keeps role and column privilege pages read-only for grants", () => {
    for (const pageName of ["roles", "column-privileges"]) {
      const source = readFileSync(new URL(`project/[ref]/database/${pageName}/+page.svelte`, import.meta.url), "utf8");
      expect(source).not.toMatch(/\b(?:GRANT|REVOKE)\b/);
    }
  });

  test("renders unavailable database size without exposing NaN", () => {
    expect(projectSettingsSource).toContain("function formatDatabaseSize(size: unknown)");
    expect(projectSettingsSource).toContain("Number.isFinite(bytes) && bytes >= 0");
    expect(projectSettingsSource).toContain("formatDatabaseSize(((project as Record<string, unknown>)?.database as Record<string, unknown>)?.size)");
    expect(projectSettingsSource).not.toContain("size as number / 1024 / 1024");
  });
});
