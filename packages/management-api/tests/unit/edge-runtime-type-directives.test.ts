import { describe, expect, test } from "bun:test";

import { normalizeEdgeRuntimeBundle } from "../../src/services/edge-runtime-bundle";

describe("Edge Runtime type-only directives", () => {
  test("removes Deno and TypeScript declaration directives from runtime code", () => {
    const sourceCode = `/// <reference types="jsr:@supabase/functions-js/edge-runtime.d.ts" />
// @deno-types="https://example.com/runtime.d.ts"
import "https://example.com/runtime.js";
/* @ts-types="./local-types.d.ts" */
// @ts-self-types="./self-types.d.ts"
export const declarationText = "types.d.ts";
export const referenceText = \`/// <reference types="preserve-me" />\`;
`;

    const normalization = normalizeEdgeRuntimeBundle(sourceCode);

    expect(normalization.code).not.toContain("edge-runtime.d.ts");
    expect(normalization.code).not.toContain("@deno-types");
    expect(normalization.code).not.toContain("@ts-types");
    expect(normalization.code).not.toContain("@ts-self-types");
    expect(normalization.code).toContain('import "https://example.com/runtime.js"');
    expect(normalization.code).toContain('declarationText = "types.d.ts"');
    expect(normalization.code).toContain('reference types="preserve-me"');
    expect(normalization.code.split("\n")).toHaveLength(sourceCode.split("\n").length);
    expect(normalization.importCount).toBe(1);
  });

  test("removes path, lib, and multiline type directives while keeping explanatory comments", () => {
    const sourceCode = `/// <reference path="./global.d.ts" />
/// <reference lib="deno.ns" />
/*
 * @ts-types="./types.d.ts"
 */
// This comment explains why @deno-types is used elsewhere.
export const active = true;
`;

    const normalization = normalizeEdgeRuntimeBundle(sourceCode);

    expect(normalization.code).not.toContain("global.d.ts");
    expect(normalization.code).not.toContain("deno.ns");
    expect(normalization.code).not.toContain("./types.d.ts");
    expect(normalization.code).toContain("// This comment explains why @deno-types is used elsewhere.");
    expect(normalization.code).toContain("export const active = true;");
    expect(normalization.code.split("\n")).toHaveLength(sourceCode.split("\n").length);
    expect(normalization.importCount).toBe(0);
  });

  test("preserves ordinary comments and existing dynamic-import normalization", () => {
    const sourceCode = `// keep this runtime explanation
var moduleSpecifier = "optional-runtime-package";
export default import(moduleSpecifier);
`;

    const normalization = normalizeEdgeRuntimeBundle(sourceCode);

    expect(normalization.code).toContain("// keep this runtime explanation");
    expect(normalization.code).toContain('import("optional-runtime-package")');
    expect(normalization.code).toContain('import("undefined")');
    expect(normalization.code).toContain('moduleSpecifier === "optional-runtime-package"');
    expect(normalization.importCount).toBe(2);
  });
});
