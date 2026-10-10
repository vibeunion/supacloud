import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkStrictGovernance } from "./check_strict_governance";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "supacloud-strict-governance-"));
  roots.push(root);
  return root;
}

test("the repository strict governance defaults pass", () => {
  expect(checkStrictGovernance(join(import.meta.dir, ".."))).toEqual([]);
});

test("reports a disabled strict compiler option", async () => {
  const root = await fixture();
  await writeFile(join(root, "tsconfig.strict.json"), JSON.stringify({
    compilerOptions: {
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noImplicitOverride: true,
      noPropertyAccessFromIndexSignature: false,
      noFallthroughCasesInSwitch: true,
    },
  }));
  await writeFile(join(root, "tsconfig.tools.json"), JSON.stringify({ extends: "./tsconfig.strict.json", compilerOptions: {} }));
  await mkdir(join(root, "packages/elysia"), { recursive: true });
  await writeFile(join(root, "packages/elysia/compatibility.json"), JSON.stringify({ packages: { effect: "4.0.2" } }));
  await mkdir(join(root, "packages/cli/src/shared/tools"), { recursive: true });
  await writeFile(join(root, "packages/cli/src/shared/tools/app-starter.ts"), strictStarterSource());
  await writeFile(join(root, "packages/cli/src/shared/tools/app-starter-templates.ts"), strictStarterSource());
  await mkdir(join(root, "packages/compiler/src"), { recursive: true });
  await writeFile(join(root, "packages/compiler/src/config.ts"), effectConfigSource());
  await expect(() => checkStrictGovernance(root)).not.toThrow();
  expect(checkStrictGovernance(root)).toContain("tsconfig.strict.json must enable noPropertyAccessFromIndexSignature.");
});

function strictStarterSource(): string {
  return [
    "noUncheckedIndexedAccess: true",
    "exactOptionalPropertyTypes: true",
    "noImplicitOverride: true",
    "noPropertyAccessFromIndexSignature: true",
    "noFallthroughCasesInSwitch: true",
  ].join("\n");
}

function effectConfigSource(): string {
  return [
    "requireRouteEffects: true",
    "requireErrorMappings: true",
    "requireDependencies: true",
    "requireTaggedErrorTypes: true",
    "requireExactDependencyTypes: true",
    "requireTimeoutForDependencies: true",
    "forbidDirectRuntimeExecution: true",
    "forbidDirectThrows: true",
  ].join("\n");
}
