import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCurrentPostgrestGeneration } from "../../src/services/postgrest-generation";
import { postgrestConfigRevision } from "../../src/services/runtime-revision";

const PROJECT_REF = "afemibrarjkvzuuawjfi";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

function currentGid(): number {
  return typeof process.getgid === "function" ? process.getgid() : 0;
}

async function tenantDirectory(): Promise<string> {
  const createdDirectory = await mkdtemp(join(tmpdir(), "supacloud-postgrest-generation-"));
  const canonicalDirectory = await realpath(createdDirectory);
  temporaryDirectories.push(canonicalDirectory);
  return canonicalDirectory;
}

describe("readCurrentPostgrestGeneration", () => {
  test("promotes a managed legacy config into the canonical generation layout", async () => {
    const directory = await tenantDirectory();
    const legacyPath = join(directory, `${PROJECT_REF}.conf`);
    const legacyContent = [
      "# Managed by SupaCloud Management API.",
      "server-port = 3100",
      "",
    ].join("\n");
    await writeFile(legacyPath, legacyContent, { mode: 0o600 });
    await chmod(legacyPath, 0o600);

    const generation = await readCurrentPostgrestGeneration({
      tenantDirectory: directory,
      projectRef: PROJECT_REF,
      controlOwnerUid: currentUid(),
      runtimeOwnerUid: currentUid(),
      runtimeGroupGid: currentGid(),
      setControlOwnership: async () => {},
    });

    const expectedRevision = postgrestConfigRevision(PROJECT_REF, legacyContent);
    const pointerPath = join(directory, `${PROJECT_REF}_postgrest.current`);
    const generationPath = join(directory, generation.pointerTarget);

    expect(generation.revision).toBe(expectedRevision);
    expect(generation.content).toBe(legacyContent);
    expect(generation.pointerTarget).toMatch(
      new RegExp(`^${PROJECT_REF}_postgrest\\.d/[a-f0-9]{64}\\.conf$`),
    );
    expect(await readFile(pointerPath, "utf8")).toBe(`${generation.pointerTarget}\n`);
    expect(await readFile(generationPath, "utf8")).toBe(legacyContent);
    expect((await lstat(generationPath)).mode & 0o7777).toBe(0o440);
  });
});
