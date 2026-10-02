import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("project packages distribute the same complete Apache-2.0 license and notices", () => {
  const license = read("LICENSE");
  const notice = read("NOTICE");
  expect(license).toContain("Apache License");
  expect(license).toContain("Version 2.0, January 2004");
  expect(license).toContain("2. Grant of Copyright License.");
  expect(license).toContain("3. Grant of Patent License.");
  expect(license).toContain("END OF TERMS AND CONDITIONS");
  expect(license).toBe(read("LICENSE-APACHE-2.0.txt"));
  expect(notice).toContain("Apache-2.0");
  expect(notice).toContain("Third-party components");
  expect(notice).toMatch(/Previously released[\s\S]*retain the permissions/);
  expect(JSON.parse(read("package.json")).license).toBe("Apache-2.0");

  for (const entry of readdirSync(resolve(root, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = `packages/${entry.name}`;
    if (!existsSync(resolve(root, directory, "package.json"))) continue;
    const manifest = JSON.parse(read(`${directory}/package.json`));
    expect(manifest.license).toBe("Apache-2.0");
    expect(read(`${directory}/LICENSE`)).toBe(license);
    expect(read(`${directory}/NOTICE`)).toBe(notice);
    expect(read(`${directory}/LICENSE-APACHE-2.0.txt`)).toBe(license);
    if (Array.isArray(manifest.files)) {
      expect(manifest.files).toContain("NOTICE");
      expect(manifest.files).toContain("LICENSE-APACHE-2.0.txt");
    }
  }
});

test("Lite release assets and documentation use the Apache filename", () => {
  for (const path of [
    ".github/workflows/release-please.yml",
    "packages/supacloud-lite/RELEASING.md",
    "packages/supacloud-lite/THIRD_PARTY_NOTICES.md",
  ]) {
    expect(read(path)).toContain("SUPACLOUD-LITE-APACHE-2.0.txt");
    expect(read(path)).not.toContain("SUPACLOUD-LITE-AGPL-3.0.txt");
  }
  expect(read(".github/workflows/release-please.yml")).toContain("cp ../../NOTICE NOTICE");
});

test("current project licensing documentation agrees with package metadata", () => {
  for (const path of [
    "CONTRIBUTING.md",
    "NOTICE",
    "README.md",
    "README.zh-CN.md",
    "README.es-ES.md",
    "packages/compiler/README.md",
  ]) {
    expect(read(path)).toContain("Apache-2.0");
    expect(read(path)).not.toContain("AGPL-3.0-only");
  }
});
