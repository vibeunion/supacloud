import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const en = JSON.parse(readFileSync(new URL("../lib/i18n/locales/en.json", import.meta.url), "utf8"));
const zh = JSON.parse(readFileSync(new URL("../lib/i18n/locales/zh.json", import.meta.url), "utf8"));
const authPages = [
  "custom-providers",
  "mfa",
  "oauth-server",
  "passkeys",
  "policies",
  "protection",
  "rate-limits",
  "sessions",
];
const hanCharacters = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

function leafKeys(value: unknown, path = ""): string[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, child]) => leafKeys(child, path ? `${path}.${key}` : key));
  }
  return [path];
}

function withoutComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("reported-issues i18n contract", () => {
  test("keeps English and Chinese locale leaf keys in parity", () => {
    expect(leafKeys(en).sort()).toEqual(leafKeys(zh).sort());
  });

  test("keeps reported Auth pages free of hardcoded CJK copy", () => {
    for (const page of authPages) {
      const source = readFileSync(new URL(`project/[ref]/auth/${page}/+page.svelte`, import.meta.url), "utf8");
      expect(withoutComments(source)).not.toMatch(hanCharacters);
    }
  });
});
