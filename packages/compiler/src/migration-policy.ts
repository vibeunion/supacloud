import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Resolved lazily: this module is bundled into consumers (for example the CLI),
// and the manifest sits next to the installed package, not next to the bundle.
// Reading it at module load would break every consumer whose bundle runs from a
// different directory (the CLI --version contract executes the built file from
// a sandbox where ../package.json does not exist).
let cachedCompilerVersion: string | undefined;

function compilerVersion(): string {
  if (cachedCompilerVersion !== undefined) return cachedCompilerVersion;
  const manifest: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  if (!manifest || typeof manifest !== "object" || !("version" in manifest) || typeof manifest.version !== "string") {
    throw new Error("Cannot determine executing compiler version");
  }
  cachedCompilerVersion = manifest.version;
  return cachedCompilerVersion;
}

// Independently versioned packages: do not infer compatibility from equal minors.
// Expand this tested tuple only with upgrade/HTTP/type acceptance evidence.
// A function, not a module-load constant: compilerVersion() reads the manifest
// next to the installed package, and bundling consumers (the CLI) execute this
// module from locations where that file does not exist at load time.
export function migrationDependencies(): Readonly<Record<string, string>> {
  return {
    "@supacloud/app": "0.16.0",
    "@supacloud/compiler": compilerVersion(),
    "@supacloud/elysia": "0.18.0",
    elysia: "1.4.30",
    typescript: "7.0.2",
  };
}

export async function checkMigrationDependencies(rootDir: string): Promise<string[]> {
  const problems: string[] = [];
  for (const [name, expected] of Object.entries(migrationDependencies())) {
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
