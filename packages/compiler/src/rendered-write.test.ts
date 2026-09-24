import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileProject } from "./compile";
import { generateApplication, renderApplication, writeRenderedApplication } from "./generate";
import { GOOD_PROJECT_FILES } from "./fixtures/good-project";
import { writeFixtureProject } from "./fixtures/helpers";

for (const optionalArtifacts of [false, true]) {
  test(`validated compilation and the public generator emit identical bytes (optional=${optionalArtifacts})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-render-parity-"));
    try {
      await writeFixtureProject(root, GOOD_PROJECT_FILES);
      const options = {
        rootDir: root,
        outDir: join(root, "generated"),
        generateClient: optionalArtifacts,
        generateOpenApi: optionalArtifacts,
        generatePermissions: optionalArtifacts,
        treeShakeUnusedProviders: optionalArtifacts,
      };
      const compiled = await compileProject(options);
      expect(compiled.diagnostics).toEqual([]);
      expect(compiled.written).toHaveLength(optionalArtifacts ? 6 : 3);
      const expected = await Promise.all(compiled.written.map((path) => readFile(path, "utf8")));
      await rm(options.outDir, { recursive: true });
      expect(await generateApplication(compiled.graph, options)).toEqual(compiled.written);
      expect(await Promise.all(compiled.written.map((path) => readFile(path, "utf8")))).toEqual(expected);

      const rendered = renderApplication(compiled.graph, options);
      const cachedOptions = { ...options, artifactHashes: new Map<string, string>() };
      expect(await writeRenderedApplication(rendered, cachedOptions)).toEqual(compiled.written);
      expect(await writeRenderedApplication(rendered, cachedOptions)).toEqual([]);
      const applicationPath = join(options.outDir, "application.ts");
      await rm(applicationPath);
      expect(await writeRenderedApplication(rendered, cachedOptions)).toEqual([applicationPath]);
      expect(await readFile(applicationPath, "utf8")).toBe(rendered.applicationCode);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
