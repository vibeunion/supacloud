import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverTypeSafetyProjects, inspectTypeSafetyProject } from "./type_safety_inventory";

test("new packages are discovered and missing checks cannot pass silently", async () => {
  const root = await mkdtemp(join(tmpdir(), "supacloud-inventory-"));
  try {
    const directory = join(root, "packages", "new-package");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "new-package" }));
    await writeFile(join(directory, "entry.ts"), "export const entry = 1;");
    const project = discoverTypeSafetyProjects(root)[0];
    if (!project) throw new Error("Package was not discovered");
    const result = inspectTypeSafetyProject(project);
    expect(result.errors).toEqual(["Missing tsconfig.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strict flags and source coverage are both checked with inherited JSONC configurations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supacloud-inventory-config-"));
  try {
    await writeFile(join(directory, "base.json"), JSON.stringify({
      compilerOptions: { strict: true, skipLibCheck: true },
    }));
    await writeFile(join(directory, "tsconfig.json"), '{\n// inherited policy\n"extends":"./base.json","include":["entry.ts"]\n}');
    await writeFile(join(directory, "entry.ts"), "export const entry = 1;");
    await writeFile(join(directory, "omitted.ts"), "export const omitted = 1;");
    const project = { name: "fixture", directory, configs: ["tsconfig.json"], svelte: false };
    expect(inspectTypeSafetyProject(project)).toMatchObject({ errors: [], files: 1 });
    await writeFile(join(directory, "tsconfig.json"), JSON.stringify({
      extends: "./base.json", compilerOptions: { strict: false }, include: ["*.ts"],
    }));
    expect(inspectTypeSafetyProject(project)).toMatchObject({
      errors: ["tsconfig.json: strict must be true"],
    });
    await writeFile(join(directory, "tsconfig.json"), JSON.stringify({
      extends: "./base.json",
      compilerOptions: { strict: true, skipLibCheck: false, strictNullChecks: false },
      include: ["*.ts"],
    }));
    expect(inspectTypeSafetyProject(project)).toMatchObject({
      errors: [
        "tsconfig.json: skipLibCheck must be true",
        "tsconfig.json: strictNullChecks must not override strict",
      ],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("JavaScript is covered only when checked; Svelte build output is not authored source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supacloud-inventory-js-"));
  try {
    const compilerOptions = { strict: true, skipLibCheck: true, allowJs: true, noEmit: true };
    await mkdir(join(directory, "build"));
    await writeFile(join(directory, "build", "bundle.js"), "export const bundled = 1;");
    await writeFile(join(directory, "launcher.cjs"), "module.exports = 1;");
    await writeFile(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions, include: ["*.cjs"] }));
    const project = { name: "fixture", directory, configs: ["tsconfig.json"], svelte: true };
    expect(inspectTypeSafetyProject(project)).toMatchObject({ errors: [], files: 0 });
    await writeFile(join(directory, "tsconfig.json"), JSON.stringify({
      compilerOptions: { ...compilerOptions, checkJs: true }, include: ["*.cjs"],
    }));
    expect(inspectTypeSafetyProject(project)).toMatchObject({ errors: [], files: 1 });
    expect(inspectTypeSafetyProject({ ...project, svelte: false })).toMatchObject({ errors: [], files: 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production inventory reports files selected by the production config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supacloud-inventory-tests-"));
  try {
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, skipLibCheck: true },
      include: ["src/**/*.ts"],
    }));
    await writeFile(join(directory, "src", "entry.ts"), "export const entry = 1;");
    const project = { name: "fixture", directory, configs: ["tsconfig.json"], svelte: false };
    expect(inspectTypeSafetyProject(project)).toMatchObject({ errors: [], files: 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
