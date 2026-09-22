import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderGraphql } from "../packages/compiler/src/graphql";

const fixture = join(import.meta.dir, "fixtures/graphql-orders");

export async function generateGraphqlOrderFixture(write = false, directory = fixture): Promise<void> {
  const outDir = join(directory, "generated");
  const result = await renderGraphql({
    rootDir: directory,
    outDir,
    graphql: { schema: join(directory, "schema.graphql") },
  });
  if (result.diagnostics.length) {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  if (write) await mkdir(outDir, { recursive: true });
  for (const [name, content] of Object.entries(result.files)) {
    const path = join(outDir, name);
    if (write) {
      await writeFile(path, content);
      continue;
    }
    let previous: string;
    try {
      previous = await readFile(path, "utf8");
    } catch (error) {
      throw new Error(`GraphQL order fixture artifact is missing: ${name}`, { cause: error });
    }
    if (previous !== content) {
      throw new Error(`GraphQL order fixture artifact is stale: ${name}; regenerate from the role-scoped schema snapshot`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--write")) throw new Error("Usage: generate_graphql_order_fixture.ts [--write]");
  await generateGraphqlOrderFixture(args.includes("--write"));
}
