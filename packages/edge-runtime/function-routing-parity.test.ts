/**
 * Pins the Edge Runtime's function routing rules to the shared parity vectors
 * that SupaCloud Lite tests also consume, so production and local runtimes
 * cannot drift on function-local URL rewriting or router detection.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isFrameworkRouterHandler, toFunctionLocalUrl } from "./function-routing";

interface RouterShape {
  handle?: boolean;
  fetch?: boolean;
  routes?: boolean;
  routeAware?: boolean;
}

const vectors = JSON.parse(
  await readFile(
    join(import.meta.dir, "../supacloud-lite/parity/function-routing.vectors.json"),
    "utf8",
  ),
) as {
  urlRewrite: Array<{ input: string; expected: string }>;
  routerDetection: Array<{ shape: RouterShape; expected: boolean; note: string }>;
};

describe("function routing parity vectors (edge-runtime)", () => {
  for (const vector of vectors.urlRewrite) {
    test(`toFunctionLocalUrl ${vector.input}`, () => {
      expect(toFunctionLocalUrl(vector.input)).toBe(vector.expected);
    });
  }

  for (const vector of vectors.routerDetection) {
    test(`isFrameworkRouterHandler: ${vector.note}`, () => {
      const shape: Record<string, unknown> = {};
      if (vector.shape.handle) shape.handle = () => new Response();
      if (vector.shape.fetch) shape.fetch = () => new Response();
      if (vector.shape.routes) shape.routes = [];
      if (vector.shape.routeAware !== undefined) {
        shape.__supacloud = { routeAware: vector.shape.routeAware };
      }
      expect(isFrameworkRouterHandler(shape)).toBe(vector.expected);
    });
  }
});
