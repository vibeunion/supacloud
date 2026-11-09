import { loadDocument } from "@zenstackhq/language";
import { PrismaSchemaGenerator, TsSchemaGenerator } from "@zenstackhq/sdk";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Datasource-only ZModel used to introspect a live database before this project
 * maintains a model. It is never written into the project: `pull` keeps it in a
 * temporary directory so introspection cannot replace authored files.
 */
export const BOOTSTRAP_MODEL_SCHEMA = `datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n`;

/** Offline model compilation: no plugin execution, no database or migration ledger writes. */
export async function compileModel(schemaFile: string, output: string, check = false): Promise<string[]> {
  const document = await loadDocument(resolve(schemaFile));
  if (!document.success) throw new Error(document.errors.join("\n"));
  const candidate = await mkdtemp(join(tmpdir(), "supacloud-model-"));
  try {
    await new TsSchemaGenerator().generate(document.model, {
      outDir: candidate, importWithFileExtension: ".js", generateModelTypes: true, generateInputTypes: true,
    });
    const prisma = await new PrismaSchemaGenerator(document.model).generate();
    if (!/provider\s*=\s*["']postgresql["']/.test(prisma)
      || !/url\s*=\s*env\(["']DATABASE_URL["']\)/.test(prisma)
      || /(?:directUrl|shadowDatabaseUrl)\s*=/.test(prisma)) {
      throw new Error('Models must use the PostgreSQL datasource with url = env("DATABASE_URL")');
    }
    await writeFile(join(candidate, "schema.prisma"), prisma);
    const files = (await readdir(candidate)).sort();
    const mismatches: string[] = [];
    for (const file of files) {
      const desired = await readFile(join(candidate, file), "utf8");
      const target = join(resolve(output), file);
      if (check) {
        const current = await readFile(target, "utf8").catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
          throw error;
        });
        if (current !== desired) mismatches.push(file);
      } else {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, desired);
      }
    }
    if (mismatches.length) throw new Error(`Model contracts are stale: ${mismatches.join(", ")}. Run supacloud-model generate.`);
    return files;
  } finally { await rm(candidate, { recursive: true, force: true }); }
}

export type ModelCommand = "generate" | "check" | "diff" | "pull";
export function modelProcess(command: "diff" | "pull", schema: string, generated: string, candidate: string) {
  // Diff introspects DATABASE_URL through the generated datasource. It never applies SQL
  // or invokes migrate dev/deploy; production has only the existing SupaCloud ledger.
  return command === "diff"
    ? { binary: "prisma", args: ["migrate", "diff", "--from-schema-datasource", join(generated, "schema.prisma"), "--to-schema-datamodel", join(generated, "schema.prisma"), "--script", "--output", candidate] }
    : { binary: "zen", args: ["db", "pull", "--no-version-check", "--schema", schema, "--output", candidate] };
}
