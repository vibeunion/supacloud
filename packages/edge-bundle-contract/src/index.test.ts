import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { normalizeEdgeFunctionBundle } from "./index.js";

describe("normalizeEdgeFunctionBundle", () => {
  for (const declaration of ["var", "let", "const"]) {
    test(`folds an immutable ${declaration} string binding`, () => {
      const source = `${declaration} OTEL_PKG = "@opentelemetry/api"; async function load() { return import(OTEL_PKG); }`;
      expect(normalizeEdgeFunctionBundle(source)).toContain('import("@opentelemetry/api")');
    });
  }

  test("folds minified names referenced from nested functions", () => {
    const source = 'var a="@opentelemetry/api";export default{async fetch(){return import(a)}}';
    expect(normalizeEdgeFunctionBundle(source)).toBe(
      'var a="@opentelemetry/api";export default{async fetch(){return import("@opentelemetry/api")}}',
    );
  });

  test("preserves literal dynamic imports", () => {
    const source = 'export const modulePromise = import("@opentelemetry/api");';
    expect(normalizeEdgeFunctionBundle(source)).toBe(source);
  });

  test("normalizes dynamic imports with an interpolation-free template literal", () => {
    const source = "export const modulePromise = import(`@opentelemetry/api`);";
    expect(normalizeEdgeFunctionBundle(source)).toBe(
      'export const modulePromise = import("@opentelemetry/api");',
    );
  });

  test("removes parentheses around a literal import target", () => {
    const source = 'export const modulePromise = import((("@opentelemetry/api")));';
    expect(normalizeEdgeFunctionBundle(source)).toBe(
      'export const modulePromise = import("@opentelemetry/api");',
    );
  });

  test("removes parentheses around a computed import target", () => {
    const source = 'const target="@opentelemetry/api";export const modulePromise=import((target));';
    expect(normalizeEdgeFunctionBundle(source)).toBe(
      'const target="@opentelemetry/api";export const modulePromise=import("@opentelemetry/api");',
    );
  });

  test("preserves import options while normalizing the complete target", () => {
    const source = 'const target="./fixture.json";export const modulePromise=import((target),{with:{type:"json"}});';
    expect(normalizeEdgeFunctionBundle(source)).toBe(
      'const target="./fixture.json";export const modulePromise=import("./fixture.json",{with:{type:"json"}});',
    );
  });

  test.each([
    ["sequence", '(0,eval)("target = \'unsafe\'")'],
    ["optional call", 'eval?.("target = \'unsafe\'")'],
  ])("allows %s indirect eval", (_caseName, indirectEval) => {
    const source = `const target="safe";${indirectEval};import(target)`;
    expect(normalizeEdgeFunctionBundle(source)).toBe(
      `const target="safe";${indirectEval};import("safe")`,
    );
  });

  test.each([
    ["assignment", 'let target="safe";target="unsafe";import(target)'],
    ["update", 'let target="safe";target++;import(target)'],
    ["destructuring write", 'let target="safe";({ target } = source);import(target)'],
    ["nested shadow", 'let target="safe";async function load(target){return import(target)}'],
    ["duplicate declaration", 'var target="safe";var target="also-safe";import(target)'],
    ["environment expression", 'const target=process.env.MODULE;import(target)'],
    ["template expression", 'const target=`${process.env.SCOPE}/module`;import(target)'],
    ["direct eval", 'const target="safe";eval("target = \'unsafe\'");import(target)'],
    ["parenthesized direct eval", 'const target="safe";((eval))("target = \'unsafe\'");import(target)'],
    ["parenthesized assignment", 'let target="safe";(target)="unsafe";import(target)'],
    ["parenthesized update", 'let target="safe";((target))++;import(target)'],
    ["parenthesized for-of write", 'let target="safe";for((target) of values){}import(target)'],
    ["var use before initialization", 'import(target);var target="safe"'],
    ["TDZ use before initialization", 'import(target);const target="safe"'],
  ])("rejects unsafe %s targets", (_caseName, source) => {
    expect(() => normalizeEdgeFunctionBundle(source)).toThrow("incompatible with the production runtime");
  });

  test("fails closed when JavaScript parsing fails", () => {
    expect(() => normalizeEdgeFunctionBundle("export const = ;")).toThrow("JavaScript parsing failed");
  });

  for (const minify of [false, true]) {
    test(`normalizes the real supabase-js OpenTelemetry import (minify=${minify})`, async () => {
      const build = await Bun.build({
        entrypoints: [join(import.meta.dir, "../test-fixtures/supabase-edge.ts")],
        target: "bun",
        minify,
      });
      expect(build.success).toBe(true);
      const rawBundle = await build.outputs[0].text();
      expect(rawBundle).toMatch(/import\(\s*[A-Za-z_$][\w$]*\s*\)/);

      const normalized = normalizeEdgeFunctionBundle(rawBundle);
      expect(normalized).toMatch(/import\([^)]*["']@opentelemetry\/api["'][^)]*\)/);
      expect(normalized).not.toMatch(/import\(\s*[A-Za-z_$][\w$]*\s*\)/);
    });
  }
});
