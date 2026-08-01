import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const layoutSource = readFileSync(new URL("./+layout.svelte", import.meta.url), "utf8");
const loginPageSource = readFileSync(new URL("./login/+page.svelte", import.meta.url), "utf8");

describe("root layout source guards", () => {
  test("i18n loading is guarded so it cannot block the app forever", () => {
    expect(layoutSource).toContain("let i18nLoadGuardExpired = $state(false);");
    expect(layoutSource).toContain("projectsLoading || ($isLoading && !i18nLoadGuardExpired)");
    expect(layoutSource).toContain("i18nLoadGuardExpired = true;");
    expect(layoutSource).toContain("clearTimeout(guardTimer);");
  });

  test("authenticated visitors leave the login page without submitting credentials", () => {
    expect(loginPageSource).toContain('import { onMount } from "svelte";');
    expect(loginPageSource).toContain("getStudioSession");
    expect(loginPageSource).toContain("session.authenticated");
    expect(loginPageSource).toContain('const CONSOLE_LANDING_PATH = "/projects";');
    expect(loginPageSource).toContain("window.location.replace(CONSOLE_LANDING_PATH)");
    expect(loginPageSource).toContain("window.location.href = CONSOLE_LANDING_PATH");
    expect(loginPageSource).not.toContain('window.location.replace("/")');
    expect(loginPageSource).not.toContain('window.location.href = "/"');
  });

  test("logout redirects only after the backend confirms success", () => {
    expect(layoutSource).toContain("const result = await logoutStudio();");
    expect(layoutSource).toContain("if (!result.success)");
    expect(layoutSource).toContain("toast.error(result.error);");
    expect(layoutSource).not.toContain("await logoutStudio();\n    } finally {");
  });
});
