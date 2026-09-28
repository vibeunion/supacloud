import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("project packages distribute the same complete AGPLv3 license and notices", () => {
  const license = read("LICENSE");
  expect(license).toContain("Version 3, 19 November 2007");
  expect(license).toContain("13. Remote Network Interaction;");
  expect(license).toContain("END OF TERMS AND CONDITIONS");
  expect(JSON.parse(read("package.json")).license).toBe("AGPL-3.0-only");

  for (const entry of readdirSync(resolve(root, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = `packages/${entry.name}`;
    if (!existsSync(resolve(root, directory, "package.json"))) continue;
    const manifest = JSON.parse(read(`${directory}/package.json`));
    expect(manifest.license).toBe("AGPL-3.0-only");
    expect(read(`${directory}/LICENSE`)).toBe(license);
    expect(read(`${directory}/NOTICE`)).toBe(read("NOTICE"));
    expect(read(`${directory}/LICENSE-APACHE-2.0.txt`)).toBe(read("LICENSE-APACHE-2.0.txt"));
  }
});

test("Lite release assets and documentation use the AGPL filename", () => {
  for (const path of [
    ".github/workflows/release-please.yml",
    "packages/supacloud-lite/RELEASING.md",
    "packages/supacloud-lite/THIRD_PARTY_NOTICES.md",
  ]) {
    expect(read(path)).toContain("SUPACLOUD-LITE-AGPL-3.0.txt");
    expect(read(path)).not.toContain("SUPACLOUD-LITE-APACHE-2.0.txt");
  }
});
