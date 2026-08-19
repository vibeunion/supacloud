import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertTrustedFunctionArtifact,
  readTrustedFunctionFile,
  withTrustedFunctionArtifact,
} from "./trusted-function-files";

describe("trusted Function runtime files", () => {
  const trustedTemporaryRoot = process.platform === "linux" ? homedir() : tmpdir();

  test("reads a regular artifact through a trusted directory chain", async () => {
    const root = await mkdtemp(join(trustedTemporaryRoot, ".supacloud-runtime-artifact-"));
    const artifactPath = join(root, "index.aaaaaaaaaaaaaaaa.js");
    await writeFile(artifactPath, "trusted artifact");
    try {
      if (process.platform === "linux") {
        const artifact = await readTrustedFunctionFile(artifactPath);
        expect(artifact.bytes.toString()).toBe("trusted artifact");
        expect(await assertTrustedFunctionArtifact(artifactPath, artifact.sha256)).toBeUndefined();
      } else {
        await expect(readTrustedFunctionFile(artifactPath)).rejects.toThrow(
          "Attested Function artifacts require Linux descriptor binding",
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "linux")(
    "rejects attested imports before invoking the module loader",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "supacloud-runtime-attested-import-"));
      const artifactPath = join(root, "index.aaaaaaaaaaaaaaaa.js");
      await writeFile(artifactPath, "trusted artifact");
      let moduleLoaderCalls = 0;
      try {
        await expect(withTrustedFunctionArtifact(
          artifactPath,
          "a".repeat(64),
          async () => {
            moduleLoaderCalls += 1;
            return "must not load";
          },
        )).rejects.toThrow("Attested Function imports require Linux descriptor binding");
        expect(moduleLoaderCalls).toBe(0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform !== "linux")(
    "rejects a writable direct parent and artifact symlink",
    async () => {
      const root = await mkdtemp(join(trustedTemporaryRoot, ".supacloud-runtime-untrusted-"));
      const outside = await mkdtemp(join(tmpdir(), "supacloud-runtime-outside-"));
      const targetPath = join(outside, "target.js");
      const artifactPath = join(root, "index.aaaaaaaaaaaaaaaa.js");
      await writeFile(targetPath, "outside");
      await symlink(targetPath, artifactPath);
      try {
        await expect(readTrustedFunctionFile(artifactPath)).rejects.toThrow(
          "Function runtime file is not trusted",
        );
        await rm(artifactPath);
        await writeFile(artifactPath, "writable parent");
        await chmod(root, 0o777);
        await expect(readTrustedFunctionFile(artifactPath)).rejects.toThrow(
          "Function runtime directory is not trusted",
        );
      } finally {
        await chmod(root, 0o700);
        await Promise.all([
          rm(root, { recursive: true, force: true }),
          rm(outside, { recursive: true, force: true }),
        ]);
      }
    },
  );

  test.skipIf(process.platform !== "linux")(
    "rejects replacement through a writable ancestor",
    async () => {
      const root = await mkdtemp(join(trustedTemporaryRoot, ".supacloud-runtime-ancestor-"));
      const trustedParent = join(root, "functions", "project");
      await mkdir(trustedParent, { recursive: true, mode: 0o700 });
      const artifactPath = join(trustedParent, "index.aaaaaaaaaaaaaaaa.js");
      await writeFile(artifactPath, "artifact");
      try {
        await chmod(join(root, "functions"), 0o777);
        await expect(readTrustedFunctionFile(artifactPath)).rejects.toThrow(
          "Function runtime directory is not trusted",
        );
      } finally {
        await chmod(join(root, "functions"), 0o700);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform !== "linux")(
    "rejects a group-writable artifact in a trusted directory",
    async () => {
      const root = await mkdtemp(join(trustedTemporaryRoot, ".supacloud-runtime-writable-file-"));
      const artifactPath = join(root, "index.aaaaaaaaaaaaaaaa.js");
      await writeFile(artifactPath, "writable artifact");
      await chmod(artifactPath, 0o660);
      try {
        await expect(readTrustedFunctionFile(artifactPath)).rejects.toThrow(
          "Function runtime file is not trusted",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
     },
  );

  test.skipIf(process.platform !== "linux")(
    "passes canonical verified artifact path to loader without ephemeral descriptor collision",
    async () => {
      const root = await mkdtemp(join(trustedTemporaryRoot, ".supacloud-runtime-canonical-"));
      const artifact1Path = join(root, "index.aaaaaaaaaaaaaaaa.js");
      const artifact2Path = join(root, "index.bbbbbbbbbbbbbbbb.js");
      await writeFile(artifact1Path, "export const name = 'artifact1';");
      await writeFile(artifact2Path, "export const name = 'artifact2';");
      const sha1 = createHash("sha256").update("export const name = 'artifact1';").digest("hex");
      const sha2 = createHash("sha256").update("export const name = 'artifact2';").digest("hex");
      try {
        const pathsLoaded: string[] = [];
        await withTrustedFunctionArtifact(artifact1Path, sha1, async (loadedPath) => {
          pathsLoaded.push(loadedPath);
          return null;
        });
        await withTrustedFunctionArtifact(artifact2Path, sha2, async (loadedPath) => {
          pathsLoaded.push(loadedPath);
          return null;
        });
        expect(pathsLoaded[0]).toBe(artifact1Path);
        expect(pathsLoaded[1]).toBe(artifact2Path);
        expect(pathsLoaded[0]).not.toContain("/proc/self/fd");
        expect(pathsLoaded[1]).not.toContain("/proc/self/fd");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
