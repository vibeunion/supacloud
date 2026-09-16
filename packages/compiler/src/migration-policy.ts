import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function compilerVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  if (!manifest || typeof manifest !== "object" || !("version" in manifest) || typeof manifest.version !== "string") {
    throw new Error("Cannot determine executing compiler version");
  }
  return manifest.version;
}

// Independently versioned packages: do not infer compatibility from equal minors.
// Expand this tested tuple only with upgrade/HTTP/type acceptance evidence.
export const migrationDependencies: Readonly<Record<string, string>> = {
  "@supacloud/app": "0.14.0",
  "@supacloud/compiler": compilerVersion(),
  "@supacloud/elysia": "0.16.0",
  elysia: "1.4.30",
  typescript: "7.0.2",
};

export async function checkMigrationDependencies(rootDir: string): Promise<string[]> {
  const problems: string[] = [];
  for (const [name, expected] of Object.entries(migrationDependencies)) {
    try {
      const manifest: unknown = JSON.parse(await readFile(resolve(rootDir, "node_modules", name, "package.json"), "utf8"));
      if (!manifest || typeof manifest !== "object" || !("name" in manifest) || manifest.name !== name
        || !("version" in manifest) || manifest.version !== expected) {
        problems.push(`${name}: requires tested installed version ${expected}`);
      }
    } catch {
      problems.push(`${name}: install tested version ${expected} in the project node_modules first`);
    }
  }
  return problems;
}
