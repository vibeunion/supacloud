import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateGraphqlOrderFixture } from "./generate_graphql_order_fixture";

test("GraphQL fixture checking detects drift without replacing an artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "graphql-fixture-check-"));
  try {
    const fixture = join(import.meta.dir, "fixtures/graphql-orders");
    await cp(join(fixture, "schema.graphql"), join(root, "schema.graphql"));
    await cp(join(fixture, "order.graphql"), join(root, "order.graphql"));
    await expect(generateGraphqlOrderFixture(false, root)).rejects.toThrow("artifact is missing");
    await generateGraphqlOrderFixture(true, root);
    await generateGraphqlOrderFixture(false, root);
    const artifact = join(root, "generated/graphql.ts");
    const original = await readFile(artifact, "utf8");
    await writeFile(artifact, `${original}\n// stale fixture\n`);
    await expect(generateGraphqlOrderFixture(false, root)).rejects.toThrow("artifact is stale");
    expect(await readFile(artifact, "utf8")).toBe(`${original}\n// stale fixture\n`);
    await writeFile(join(root, "order.graphql"), "query Broken { missingField }");
    await expect(generateGraphqlOrderFixture(true, root)).rejects.toThrow("missingField");
    expect(await readFile(artifact, "utf8")).toBe(`${original}\n// stale fixture\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
