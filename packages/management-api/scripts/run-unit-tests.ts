import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const packageRoot = join(import.meta.dir, "..");
const unitRoot = join(packageRoot, "tests", "unit");
const apiTest = join(packageRoot, "src", "api.test.ts");

async function listTestFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTestFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }

  return files.sort();
}

export function usesProcessGlobalModuleMock(source: string): boolean {
  return /\bmock\.module\s*\(/.test(source);
}

async function runTestBatch(files: string[], label: string): Promise<void> {
  if (files.length === 0) return;

  console.log(`\n[test:unit] ${label} (${files.length} file${files.length === 1 ? "" : "s"})`);
  const child = Bun.spawn(["bun", "test", ...files], {
    cwd: packageRoot,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${exitCode}`);
  }
}

export async function runUnitTests(): Promise<void> {
  const unitFiles = await listTestFiles(unitRoot);
  const classified = await Promise.all(unitFiles.map(async (file) => ({
    file,
    isolated: usesProcessGlobalModuleMock(await readFile(file, "utf8")),
  })));
  const sharedFiles = classified.filter((entry) => !entry.isolated).map((entry) => entry.file);
  const isolatedFiles = classified.filter((entry) => entry.isolated).map((entry) => entry.file);

  await runTestBatch(sharedFiles, "shared unit tests");
  for (const file of isolatedFiles) {
    await runTestBatch([file], `isolated ${relative(packageRoot, file)}`);
  }
  await runTestBatch([apiTest], "isolated src/api.test.ts");
}

if (import.meta.main) {
  try {
    await runUnitTests();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
