import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import postcss from "postcss";

const appPath = fileURLToPath(new URL("./app.css", import.meta.url));
const appSource = readFileSync(appPath, "utf8");
const appCss = postcss.parse(appSource);
const uiThemeSource = readFileSync(
  fileURLToPath(import.meta.resolve("@svadmin/ui/app.theme.css")),
  "utf8",
);

describe("SVAdmin stylesheet migration", () => {
  test("uses public component entries without the AdminApp stylesheet side effect", () => {
    const root = fileURLToPath(new URL("./", import.meta.url));
    const files = new Bun.Glob("**/*.svelte").scanSync({ cwd: root, absolute: true });
    for (const file of files) {
      if (file.includes(".test-")) continue;
      expect(readFileSync(file, "utf8")).not.toMatch(/from\s+["']@svadmin\/ui["']/);
    }
  });

  test("imports only the Tailwind host entry and keeps AI styles separate", () => {
    const imports: string[] = [];
    const sources: string[] = [];
    appCss.walkAtRules("import", (rule) => { imports.push(rule.params); });
    appCss.walkAtRules("source", (rule) => { sources.push(rule.params); });

    expect(imports).toEqual([
      '"tailwindcss"',
      '"@svadmin/ui/app.theme.css"',
      '"@svadmin/ai-elements/ai.css"',
    ]);
    expect(sources.some((source) => source.includes("@svadmin/ui"))).toBe(false);
    expect(sources.some((source) => source.includes("@svadmin/ai-elements"))).toBe(true);
  });

  test("preserves light and dark colors as complete semantic color values", () => {
    const themes = new Map<string, Map<string, string>>();
    appCss.walkRules((rule) => {
      if (rule.selector !== ":root" && rule.selector !== ".dark") return;
      const tokens = new Map<string, string>();
      rule.walkDecls((declaration) => {
        if (declaration.prop.startsWith("--") && declaration.prop !== "--radius") {
          expect(declaration.value).toMatch(/^hsl\([^)]+\)$/);
          tokens.set(declaration.prop, declaration.value);
        }
      });
      themes.set(rule.selector, tokens);
    });

    expect(themes.get(":root")?.get("--background")).toBe("hsl(0 0% 100%)");
    expect(themes.get(".dark")?.get("--background")).toBe("hsl(240 10% 3.9%)");
    expect(themes.get(":root")?.size).toBe(19);
    expect(themes.get(".dark")?.size).toBe(19);
    expect(appSource).not.toContain("hsl(var(");
    expect(appSource).toContain("@custom-variant dark (&:where(.dark, .dark *))");
  });

  test("compiles published component and table aliases without host UI scanning", async () => {
    const result = await postcss([
      tailwindcss({ base: fileURLToPath(new URL("../", import.meta.url)), optimize: false }),
    ]).process(appSource, { from: appPath });
    const css = result.css;
    const tableSource = readFileSync(
      fileURLToPath(import.meta.resolve("@svadmin/ui/components/AutoTable.svelte")),
      "utf8",
    );
    const aliases = new Set(tableSource.match(/\bsvadmin-u-[a-f0-9]+\b/g));
    expect(aliases.size).toBeGreaterThan(0);
    for (const alias of aliases) {
      expect(uiThemeSource).toContain(`.${alias}`);
      expect(css).toContain(`.${alias}`);
    }
    expect(css).toContain(".svadmin-button");
    expect(css).toContain(".svadmin-table");
    expect(css).toContain("--color-background: var(--background)");
    expect(css).toContain("--background: hsl(0 0% 100%)");
    expect(css).toContain("--background: hsl(240 10% 3.9%)");
    expect(css).not.toContain('@import "@svadmin/');
  }, 30_000);
});
