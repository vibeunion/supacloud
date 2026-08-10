import { describe, expect, test } from "bun:test";
import { normalizeEdgeRuntimeBundle } from "../../src/services/edge-runtime-bundle";

const computedImportRejectionCases = [
  ["a reassigned binding", `
    var optionalPackage = "first-package";
    optionalPackage = "second-package";
    export const modulePromise = import(optionalPackage);
  `],
  ["duplicate top-level declarations", `
    var optionalPackage = "first-package";
    var optionalPackage = "second-package";
    export const modulePromise = import(optionalPackage);
  `],
  ["duplicate declarators in one declaration", `
    var optionalPackage = "first-package", optionalPackage = "second-package";
    export const modulePromise = import(optionalPackage);
  `],
  ["an update expression", `
    var optionalPackage = "optional-runtime-package";
    optionalPackage++;
    export const modulePromise = import(optionalPackage);
  `],
  ["a logical assignment", `
    var optionalPackage = "optional-runtime-package";
    optionalPackage ||= "fallback-package";
    export const modulePromise = import(optionalPackage);
  `],
  ["a destructuring assignment", `
    var optionalPackage = "optional-runtime-package";
    ({ optionalPackage } = { optionalPackage: "different-package" });
    export const modulePromise = import(optionalPackage);
  `],
  ["a for-of write", `
    var optionalPackage = "optional-runtime-package";
    for (optionalPackage of ["different-package"]) {}
    export const modulePromise = import(optionalPackage);
  `],
  ["a shadowed binding", `
    var optionalPackage = "optional-runtime-package";
    export function loadOptionalPackage(optionalPackage) {
      return import(optionalPackage);
    }
  `],
  ["an environment expression", `
    export const modulePromise = import(process.env.RUNTIME_PACKAGE);
  `],
  ["an interpolated template", `
    const packageScope = "optional";
    export const modulePromise = import(\`\${packageScope}/runtime-package\`);
  `],
  ["a lexical binding", `
    const optionalPackage = "optional-runtime-package";
    export const modulePromise = import(optionalPackage);
  `],
] as const;

async function moduleEvaluation(code: string): Promise<"loaded" | "rejected"> {
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  try {
    await import(moduleUrl);
    return "loaded";
  } catch {
    return "rejected";
  }
}

describe("Edge Runtime final bundle compatibility", () => {
  test("normalizes an immutable top-level string dynamic import", () => {
    const normalization = normalizeEdgeRuntimeBundle(`
      var optionalPackage = "optional-runtime-package";
      export async function loadOptionalPackage() {
        return import(optionalPackage).catch(() => null);
      }
    `);

    expect(normalization.code).toContain('import("optional-runtime-package")');
    expect(normalization.code).toContain('import("undefined")');
    expect(normalization.code).not.toContain("import(optionalPackage)");
    expect(normalization.code).toContain('optionalPackage === "optional-runtime-package"');
    expect(normalization.importCount).toBe(2);
  });

  test("preserves rejection when a closure is called before its binding initializes", async () => {
    const sourceCode = `
      await loadOptionalPackage();
      var optionalPackage = "node:path";
      function loadOptionalPackage() {
        return import(optionalPackage);
      }
    `;
    const normalization = normalizeEdgeRuntimeBundle(sourceCode);

    expect(normalization.code).toContain('import("node:path")');
    expect(normalization.code).toContain('import("undefined")');
    expect(normalization.code).not.toContain("import(optionalPackage)");
    expect(await moduleEvaluation(sourceCode)).toBe("rejected");
    expect(await moduleEvaluation(normalization.code)).toBe("rejected");
  });

  test("preserves loading after the binding initializes", async () => {
    const sourceCode = `
      var optionalPackage = "node:path";
      await loadOptionalPackage();
      function loadOptionalPackage() {
        return import(optionalPackage);
      }
    `;
    const normalization = normalizeEdgeRuntimeBundle(sourceCode);

    expect(await moduleEvaluation(sourceCode)).toBe("loaded");
    expect(await moduleEvaluation(normalization.code)).toBe("loaded");
  });

  test("preserves import options in both proven literal branches", () => {
    const normalization = normalizeEdgeRuntimeBundle(`
      var optionalPackage = "./optional-runtime-package.json";
      export const modulePromise = import(optionalPackage, { with: { type: "json" } });
    `);

    expect(normalization.code).toContain(
      'import("./optional-runtime-package.json", { with: { type: "json" } })',
    );
    expect(normalization.code).toContain(
      'import("undefined", { with: { type: "json" } })',
    );
  });

  test("keeps literal dynamic imports unchanged", () => {
    const sourceCode = 'export const modulePromise = import("optional-runtime-package");';

    expect(normalizeEdgeRuntimeBundle(sourceCode)).toEqual({ code: sourceCode, importCount: 1 });
  });

  test("counts unique imports from the normalized final artifact", () => {
    const sourceCode = `
      import "first-package";
      export { value } from "second-package";
      export const third = import(\`third-package\`);
      export const duplicate = import("first-package");
    `;

    expect(normalizeEdgeRuntimeBundle(sourceCode).importCount).toBe(3);
  });

  test.each(computedImportRejectionCases)("rejects %s", (_caseName, sourceCode) => {
    expect(() => normalizeEdgeRuntimeBundle(sourceCode))
      .toThrow("computed dynamic imports are disabled");
  });

  test("rejects direct eval when normalizing a computed dynamic import", () => {
    expect(() => normalizeEdgeRuntimeBundle(`
      var optionalPackage = "optional-runtime-package";
      eval('optionalPackage = "different-package"');
      export const modulePromise = import(optionalPackage);
    `)).toThrow("direct eval prevents proving computed dynamic import bindings are immutable");
  });
});
