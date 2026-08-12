import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  EDGE_FUNCTION_ACTIVATION_SCHEMA,
  edgeFunctionActivationGenerationPath,
  writeEdgeFunctionActivationGeneration,
  type EdgeFunctionActivationAuthority,
} from "../../src/services/edge-function-activation-manifest";

const ACTIVATION_ID = "00000000-0000-4000-8000-000000000001";
const fixtureRoots: string[] = [];
const authority: EdgeFunctionActivationAuthority = {
  schema: EDGE_FUNCTION_ACTIVATION_SCHEMA,
  activation_id: ACTIVATION_ID,
  activation_generation: 1,
  previous_activation_id: null,
  target_state: "active",
  artifact_sha256: "a".repeat(64),
};

async function activationFixture(): Promise<{
  projectDirectory: string;
  outsideDirectory: string;
}> {
  const root = await mkdtemp(join(homedir(), ".supacloud-activation-generation-"));
  const projectDirectory = join(root, "functions", "project-ref");
  const outsideDirectory = join(root, "outside");
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(outsideDirectory);
  fixtureRoots.push(root);
  return { projectDirectory, outsideDirectory };
}

async function writeGeneration(projectDirectory: string): Promise<string> {
  return writeEdgeFunctionActivationGeneration({
    projectDirectory,
    functionSlug: "fa-api",
    config: { version: "1", verify_jwt: true },
    authority,
  });
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Edge Function activation generation manifests", () => {
  test.each(["../escape", "nested/escape", "", "."])(
    "rejects the unsafe Function slug %j before resolving a writer path",
    (functionSlug) => {
      expect(() => edgeFunctionActivationGenerationPath(
        "/trusted/project",
        functionSlug,
        ACTIVATION_ID,
      )).toThrow("Invalid Function slug");
    },
  );

  test("writes and reads back a generation through trusted directories", async () => {
    const { projectDirectory } = await activationFixture();
    const generationPath = await writeGeneration(projectDirectory);
    expect(JSON.parse(await readFile(generationPath, "utf8"))).toMatchObject({
      version: "1",
      _supacloud_activation: { activation_id: ACTIVATION_ID },
    });
  });

  test.each(["activation root", "Function slug"])(
    "rejects an existing %s symlink parent without writing through it",
    async (symlinkScope) => {
      const { projectDirectory, outsideDirectory } = await activationFixture();
      const activationRoot = join(projectDirectory, ".activation-generations");
      if (symlinkScope === "activation root") {
        await symlink(outsideDirectory, activationRoot, "dir");
      } else {
        await mkdir(activationRoot);
        await symlink(outsideDirectory, join(activationRoot, "fa-api"), "dir");
      }

      await expect(writeGeneration(projectDirectory)).rejects.toThrow(
        "Function mutation directory is not trusted",
      );
      expect(await Bun.file(join(outsideDirectory, `${ACTIVATION_ID}.json`)).exists()).toBe(false);
    },
  );
});
