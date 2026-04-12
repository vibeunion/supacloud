// Auto-dependency scanner — extracts npm deps from function code during
// deployment and auto-installs missing packages
import { $ } from "bun";

/** Extract all npm dependency names from function source code */
export function extractDeps(code: string): string[] {
  const deps = new Set<string>();

  // esm.sh imports: import xxx from "https://esm.sh/zod@3.22"
  for (const m of code.matchAll(
    /from\s+["']https:\/\/esm\.sh\/(?:v\d+\/)?([^@"'\s]+)/g,
  )) {
    deps.add(m[1]);
  }

  // skypack imports
  for (const m of code.matchAll(
    /from\s+["']https:\/\/cdn\.skypack\.dev\/([^@"'\s]+)/g,
  )) {
    deps.add(m[1]);
  }

  // npm: prefix imports: import xxx from "npm:postgres"
  for (const m of code.matchAll(/from\s+["']npm:([^@"'\s]+)/g)) {
    deps.add(m[1]);
  }

  // jsr: prefix imports: import xxx from "jsr:@supabase/supabase-js@2"
  for (const m of code.matchAll(/from\s+["']jsr:([^@"'\s]+)/g)) {
    deps.add(m[1]);
  }

  // Regular npm imports (exclude relative, node: builtins, and paths)
  for (const m of code.matchAll(/from\s+["']([a-z@][^"'\s]*?)["']/g)) {
    const pkg = m[1];
    if (
      !pkg.startsWith(".") &&
      !pkg.startsWith("node:") &&
      !pkg.startsWith("/")
    ) {
      // Extract package name (@scope/name or name)
      const name = pkg.startsWith("@")
        ? pkg.split("/").slice(0, 2).join("/")
        : pkg.split("/")[0];
      deps.add(name);
    }
  }

  return [...deps];
}

/** Check which packages are not installed */
async function findMissing(deps: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const dep of deps) {
    try {
      // Bun.resolveSync checks if module can be resolved from the current directory
      Bun.resolveSync(dep, import.meta.dir);
    } catch {
      missing.push(dep);
    }
  }
  return missing;
}

/** Auto-scan and install missing dependencies for a function file */
export async function autoInstallDeps(functionPath: string) {
  const code = await Bun.file(functionPath).text();
  const deps = extractDeps(code);

  if (deps.length === 0) return;

  const missing = await findMissing(deps);
  if (missing.length > 0) {
    console.log(`[AutoDeps] Installing missing deps: ${missing.join(", ")}`);
    const cwd = import.meta.dir; // edge-runtime package root
    await $`bun add ${missing}`.cwd(cwd);
    console.log("[AutoDeps] Installation complete");
  }
}
