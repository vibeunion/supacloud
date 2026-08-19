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
    expect(normalization.importCount).toBe(0);
  });

  test("preserves ordinary comments and existing dynamic-import normalization", () => {
    const sourceCode = `// keep this runtime explanation
const moduleSpecifier = "optional-runtime-package";
export default import(moduleSpecifier);
`;

    const normalization = normalizeEdgeRuntimeBundle(sourceCode);

    expect(normalization.code).toContain("// keep this runtime explanation");
    expect(normalization.code).toContain(
      'import("optional-runtime-package").catch(() => import("undefined"))',
    );
    expect(normalization.importCount).toBe(2);
  });
});
