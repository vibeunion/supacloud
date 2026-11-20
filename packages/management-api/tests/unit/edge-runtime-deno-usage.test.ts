import { describe, expect, test } from "bun:test";

import { denoRuntimeUsageError, findDenoRuntimeUsage } from "../../src/services/edge-runtime-deno-usage";

describe("Deno runtime usage guard", () => {
  test("accepts a Bun-native handler", () => {
    const source = `export default (request: Request, ctx: { env: Record<string, string> }) =>
  Response.json({ url: request.url, secret: ctx.env.SECRET });
`;
    expect(findDenoRuntimeUsage(source)).toEqual([]);
    expect(denoRuntimeUsageError(source)).toBeUndefined();
  });

  test("reports the first unsupported API with its line and migration", () => {
    const source = `Deno.serve((request) => new Response(request.url));
`;
    const usage = findDenoRuntimeUsage(source);

    expect(usage).toHaveLength(1);
    expect(usage[0]?.api).toBe("Deno.serve()");
    expect(usage[0]?.line).toBe(1);
    expect(usage[0]?.guidance).toContain("export a default handler");

    const error = denoRuntimeUsageError(source);
    expect(error).toContain("Deno compatibility layer");
    expect(error).toContain("line 1: Deno.serve()");
    expect(error).toContain("docs/edge-runtime-guide.md#function-contract");
  });

  test("reports env and filesystem APIs once per line", () => {
    const source = `const url = Deno.env.get("SUPABASE_URL");
const text = await Deno.readTextFile("./seed.json");
`;
    const usage = findDenoRuntimeUsage(source);

    expect(usage.map((entry) => entry.api)).toEqual(["Deno.env", "Deno file APIs"]);
    expect(usage.map((entry) => entry.line)).toEqual([1, 2]);
  });

  test("ignores comments, strings and template text", () => {
    const source = `// Deno.serve(handler) was removed.
/* Deno.env and Deno.readTextFile are gone. */
const migration = "Deno.serve(handler) -> export default handler";
const example = \`
Deno.env.get("SECRET")
\`;
export default () => Response.json({ migration, example });
`;
    expect(findDenoRuntimeUsage(source)).toEqual([]);
  });

  test("still inspects code inside template interpolation", () => {
    const source = `export default () => Response.json({ env: \`\${Deno.env.get("SECRET")}\` });
`;
    expect(findDenoRuntimeUsage(source).map((entry) => entry.api)).toEqual(["Deno.env"]);
  });

  test("rejects deno.land and jsr module specifiers", () => {
    const source = `import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import postgres from "jsr:@db/postgres@0.19.0";

export default () => new Response("ok");
`;
    const usage = findDenoRuntimeUsage(source);

    expect(usage.map((entry) => entry.api)).toEqual([
      "Deno/JSR module imports",
      "Deno/JSR module imports",
    ]);
    expect(usage.map((entry) => entry.line)).toEqual([1, 2]);
    expect(usage[0]?.guidance).toContain("npm:package@version");
  });

  test("does not treat unrelated Deno prose in an import line as usage", () => {
    const source = `import { helper } from "./deno.land-helper.ts";
const text = "import \\"https://deno.land/std/http/server.ts\\"";
export default () => new Response(text + helper);
`;
    expect(findDenoRuntimeUsage(source)).toEqual([]);
  });

  test("keeps TypeScript syntax that a parser cannot read from disabling the guard", () => {
    const source = `interface Context { env: Record<string, string> }
export default (request: Request, ctx: Context): Response => {
  const value: string = Deno.env.get("SECRET") ?? "";
  return new Response(value);
};
`;
    expect(findDenoRuntimeUsage(source).map((entry) => entry.line)).toEqual([3]);
  });
});