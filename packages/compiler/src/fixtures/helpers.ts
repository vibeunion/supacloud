import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 把 fixture 文件表写入目录（自动建父目录）。 */
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

/** 源码中包含 marker 的行号（1 起），用于断言诊断位置。 */
export function lineOf(source: string, marker: string): number {
  const index = source.split("\n").findIndex((line) => line.includes(marker));
  if (index === -1) throw new Error(`marker not found: ${marker}`);
  return index + 1;
}
