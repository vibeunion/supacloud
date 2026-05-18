import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const indexSource = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");

describe("static assets source guards", () => {
  test("root /index.html miss can fall through to embedded assets fallback", () => {
    expect(indexSource).toContain('const isRootIndexFallback = url.pathname === "/" && path === "/index.html";');
    expect(indexSource).toContain(
      "if ((isImmutableAsset(path) || hasFileExtension(path)) && !isRootIndexFallback)",
    );
  });
});
