import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Writes fixture files map to directory (auto-creates parent directories). */
export async function writeFixtureProject(
  rootDir: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const absPath = join(rootDir, relativePath);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content, "utf8");
  }
}

/** 1-based line number containing marker in source, used to assert diagnostic positions. */
export function lineOf(source: string, marker: string): number {
  const index = source.split("\n").findIndex((line) => line.includes(marker));
  if (index === -1) throw new Error(`marker not found: ${marker}`);
  return index + 1;
}
